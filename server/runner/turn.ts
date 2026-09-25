import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app.ts';
import { maxSeq, renderMessage, renderUpdate, selectDelta } from '../context/delta.ts';
import { renderSeed } from '../context/seed.ts';
import type { ConversationRow, MessageRow, SessionRow, ThreadRow } from '../db/queries.ts';
import { serializeMessage } from '../core/serialize.ts';
import { sessionKey, KeyedMutex } from './locks.ts';
import type { RunnerEvent } from './parse.ts';
import { Semaphore } from './queue.ts';
import { buildArgs, childEnv, flagsHash, spawnClaude, type SessionArgs, type SpawnMode, type TurnProcess } from './spawn.ts';

export interface TurnTrigger {
  /** The message this turn answers; excluded from the delta because it is sent as <message>. */
  messageId?: string;
  /** Its done_seq (or, for routines, the run header's seq). */
  seq?: number;
  text: string;
  /** "you", "workflow:<name>", "routine:<name>". */
  from: string;
  /** Directories the message references (#dir chips); the turn still runs in its own cwd. */
  dirs?: string[];
}

export interface TurnRequest {
  threadId: string;
  agentName: string;
  cwd: string;
  trigger: TurnTrigger;
  runId?: string | null;
  meta?: unknown;
}

export interface TurnOutcome {
  messageId: string;
  status: 'done' | 'error' | 'cancelled';
  text: string;
  error?: string;
}

interface Prepared {
  args: SessionArgs;
  prompt: string;
  cursor: number;
  markers: string[];
  kind: 'resume' | 'fork' | 'seed';
  /** The stored session this turn resumes or forks, dropped if its transcript is gone. */
  from?: { threadId: string; cwd: string };
}

/**
 * The tool_events column holds the turn's steps: tool calls and thinking. `at` is the length of the
 * message text when the step began, so the chat can show each step where it happened; `seq` orders
 * steps that began at the same length.
 */
interface ToolEvent {
  id: string;
  name: string;
  input: unknown;
  output_preview?: string;
  denied?: boolean;
  is_error?: boolean;
  at: number;
  seq: number;
}

interface ThinkingEvent {
  kind: 'thinking';
  id: string;
  text: string;
  at: number;
  seq: number;
}

const FLUSH_MS = 500;

export class TurnRunner {
  readonly semaphore: Semaphore;
  private locks = new KeyedMutex();
  private active = new Map<string, { abort: AbortController; proc?: TurnProcess }>();

  constructor(private readonly ctx: AppContext) {
    this.semaphore = new Semaphore(ctx.cfg.config.maxConcurrent);
    ctx.onConfig((cfg) => this.semaphore.setMax(cfg.config.maxConcurrent));
    this.writeGateSettings();
    // Turns from a previous server process cannot be resumed mid-stream.
    for (const m of ctx.store.unfinishedMessages()) {
      ctx.store.updateMessage(m.id, { status: 'error', error: 'interrupted: the server restarted during this turn' });
    }
  }

  /** gate-settings.json registers the PreToolUse hook. Its path (a flag) never changes. */
  writeGateSettings(): void {
    const { gateSettings, hookScript } = this.ctx.paths;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const settings = {
      // A project's `disableAllHooks: true` would switch the gate off; --settings outranks it (NOTES.md).
      disableAllHooks: false,
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${q(process.execPath)} ${q(hookScript)}` }] }],
      },
    };
    const text = JSON.stringify(settings, null, 2) + '\n';
    fs.mkdirSync(path.dirname(gateSettings), { recursive: true });
    if (!fs.existsSync(gateSettings) || fs.readFileSync(gateSettings, 'utf8') !== text) fs.writeFileSync(gateSettings, text);
  }

  isActive(messageId: string): boolean {
    return this.active.has(messageId);
  }

  /** Creates the agent message immediately (status queued) and runs the turn in the background. */
  start(req: TurnRequest): { messageId: string; done: Promise<TurnOutcome> } {
    const { store, hub } = this.ctx;
    const msg = store.insertMessage({
      thread_id: req.threadId,
      author_kind: 'agent',
      author_id: req.agentName,
      status: 'queued',
      run_id: req.runId ?? null,
      cwd: req.cwd,
      meta: req.meta,
    });
    hub.thread(req.threadId, 'message.created', serializeMessage(msg));
    const abort = new AbortController();
    this.active.set(msg.id, { abort });
    const done = this.run(msg, req, abort.signal).finally(() => this.active.delete(msg.id));
    return { messageId: msg.id, done };
  }

  cancel(messageId: string): boolean {
    const a = this.active.get(messageId);
    if (!a) return false;
    a.abort.abort();
    a.proc?.cancel();
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }

  private emitUpdate(id: string, threadId: string): MessageRow {
    const m = this.ctx.store.getMessage(id)!;
    this.ctx.hub.thread(threadId, 'message.updated', serializeMessage(m));
    return m;
  }

  private finish(msg: MessageRow, status: TurnOutcome['status'], patch: Parameters<AppContext['store']['updateMessage']>[1], text = ''): TurnOutcome {
    const { store, hub } = this.ctx;
    if (status === 'done') {
      store.updateMessage(msg.id, patch);
      store.markDone(msg.id);
    } else {
      store.updateMessage(msg.id, { ...patch, status });
    }
    const final = store.getMessage(msg.id)!;
    hub.thread(msg.thread_id, 'message.done', serializeMessage(final));
    return { messageId: msg.id, status, text, error: final.error ?? undefined };
  }

  private async run(msg: MessageRow, req: TurnRequest, signal: AbortSignal): Promise<TurnOutcome> {
    const { store } = this.ctx;
    let releaseLock: (() => void) | undefined;
    let releaseSlot: (() => void) | undefined;
    try {
      releaseLock = await this.locks.acquire(sessionKey(req.threadId, req.agentName, req.cwd), signal);
      releaseSlot = await this.semaphore.acquire(signal);
    } catch {
      releaseLock?.();
      return this.finish(msg, 'cancelled', {});
    }
    try {
      return await this.execute(msg, req, signal, true);
    } catch (e: any) {
      return this.finish(msg, 'error', { error: `internal error: ${e?.message ?? e}` });
    } finally {
      releaseSlot();
      releaseLock();
    }
  }

  private async execute(msg: MessageRow, req: TurnRequest, signal: AbortSignal, allowRetry: boolean): Promise<TurnOutcome> {
    const { store, cfg, paths } = this.ctx;
    const agent = cfg.agents[req.agentName];
    if (!agent) return this.finish(msg, 'error', { error: `unknown agent "${req.agentName}"` });
    const thread = store.getThread(req.threadId)!;
    const conversation = store.getConversation(thread.conversation_id)!;
    if (!fs.existsSync(req.cwd)) return this.finish(msg, 'error', { error: `working directory does not exist: ${req.cwd}` });

    const spawnAgent = agent.raw
      ? { model: agent.model }
      : { model: agent.model ?? cfg.config.defaultModel, systemPrompt: agent.body, render: agent.render };
    const mode: SpawnMode = { settingsPath: paths.gateSettings, partial: true };
    const bin = cfg.config.claudeBin;
    const hashAt = (cwd: string) => flagsHash(bin, spawnAgent, mode, cwd);
    const hash = hashAt(req.cwd);
    const prep = this.prepare(thread, conversation, req, hashAt);

    store.updateMessage(msg.id, { status: 'streaming', markers: prep.markers.length ? JSON.stringify(prep.markers) : null });
    this.emitUpdate(msg.id, req.threadId);
    if (signal.aborted) return this.finish(msg, 'cancelled', {});

    let text = '';
    let dirty = false;
    let sessionId: string | null = null;
    let firstUsage: unknown = null;
    let result: Extract<RunnerEvent, { type: 'result' }> | null = null;
    const tools: ToolEvent[] = [];
    const thinking: ThinkingEvent[] = [];
    let steps = 0;

    const flush = () => {
      if (!dirty) return;
      dirty = false;
      store.updateMessage(msg.id, { content_md: text, tool_events: JSON.stringify([...tools, ...thinking]) });
    };
    const timer = setInterval(flush, FLUSH_MS);

    const onEvent = (e: RunnerEvent) => {
      switch (e.type) {
        case 'init':
          sessionId = e.sessionId;
          // The prompt is in the session transcript from here on, so the cursor advances now.
          store.upsertSession({
            thread_id: req.threadId,
            agent_id: req.agentName,
            cwd: req.cwd,
            claude_session_id: e.sessionId,
            last_seen_seq: prep.cursor,
            flags_hash: hash,
          });
          store.updateMessage(msg.id, { session_id: e.sessionId });
          break;
        case 'textDelta':
          text += e.text;
          dirty = true;
          this.ctx.hub.thread(req.threadId, 'message.delta', { id: msg.id, text: e.text });
          break;
        case 'thinkingDelta': {
          let t = thinking.find((x) => x.id === e.block);
          if (!t) thinking.push((t = { kind: 'thinking', id: e.block, text: '', at: text.length, seq: steps++ }));
          t.text += e.text;
          dirty = true;
          this.ctx.hub.thread(req.threadId, 'message.thinking', { id: msg.id, thinkingId: t.id, at: t.at, seq: t.seq, text: e.text });
          break;
        }
        case 'toolUse':
          tools.push({ id: e.id, name: e.name, input: e.input, at: text.length, seq: steps++ });
          dirty = true;
          this.ctx.hub.thread(req.threadId, 'message.tool', { id: msg.id, toolEvents: tools });
          break;
        case 'toolResult': {
          const t = tools.find((x) => x.id === e.id);
          if (t) {
            t.output_preview = e.preview;
            t.is_error = e.isError;
            t.denied = e.denied;
            dirty = true;
            this.ctx.hub.thread(req.threadId, 'message.tool', { id: msg.id, toolEvents: tools });
          }
          break;
        }
        case 'firstUsage':
          firstUsage = e.usage;
          break;
        case 'result':
          result = e;
          break;
      }
    };

    const proc = spawnClaude({
      bin,
      args: buildArgs(spawnAgent, prep.args, mode),
      cwd: req.cwd,
      env: childEnv({
        AGENT_MODE: conversation.yolo ? 'yolo' : 'readonly',
        AGENT_TOOLS: JSON.stringify(agent.tools ?? []),
        AGENT_CHAT_RUN_ID: req.runId ?? msg.id,
        AGENT_CHAT_GATE_CONFIG: paths.gateJson,
        AGENT_CHAT_HOOK_LOG: paths.hookLog,
      }),
      prompt: prep.prompt,
      onEvent,
    });
    const entry = this.active.get(msg.id);
    if (entry) entry.proc = proc;
    if (signal.aborted) proc.cancel();

    const exit = await proc.done;
    clearInterval(timer);
    dirty = true;
    flush();

    const res = result as Extract<RunnerEvent, { type: 'result' }> | null;
    const usage = res?.usage ? { ...res.usage, iterations: undefined, first_call: firstUsage, total_cost_usd: res.costUsd } : null;
    const usageJson = usage ? JSON.stringify(usage) : null;

    if (signal.aborted) return this.finish(msg, 'cancelled', { usage: usageJson }, text);

    if (res && !res.isError && exit.code === 0) {
      if (!text.trim() && res.text) text = res.text;
      return this.finish(msg, 'done', { content_md: text, usage: usageJson }, text);
    }

    const errText = [res?.errors?.join('; '), res?.isError ? res.text : undefined, exit.spawnError, exit.stderrTail.trim()]
      .filter(Boolean)
      .join('\n');

    // The transcript behind a stored session is gone (e.g. deleted); start over with a seed once.
    if (allowRetry && !sessionId && prep.from && /No conversation found/i.test(errText)) {
      store.deleteSession(prep.from.threadId, req.agentName, prep.from.cwd);
      return this.execute(msg, req, signal, false);
    }

    const reason = exit.spawnError
      ? `could not start ${bin}: ${exit.spawnError}`
      : res?.isError
        ? `Claude reported an error (${res.subtype ?? 'error'})`
        : `claude exited with code ${exit.code ?? exit.signal}`;
    return this.finish(msg, 'error', { content_md: text, usage: usageJson, error: `${reason}\n${errText}`.trim().slice(0, 4000) }, text);
  }

  /** Session resolution for (thread, agent, cwd): resume, fork from the parent thread, or seed. */
  private prepare(thread: ThreadRow, conversation: ConversationRow, req: TurnRequest, hashAt: (cwd: string) => string): Prepared {
    const { store } = this.ctx;
    const hash = hashAt(req.cwd);
    const markers: string[] = [];
    const threadMsgs = store.doneMessages(thread.id);
    const exclude = req.trigger.messageId ? [req.trigger.messageId] : [];
    const message = join(renderDirRefs(req.trigger.dirs, req.cwd), renderMessage(req.trigger.from, req.trigger.text));
    const triggerSeq = req.trigger.seq ?? 0;

    let session: SessionRow | undefined = store.getSession(thread.id, req.agentName, req.cwd);
    if (session && session.flags_hash !== hash) {
      markers.push('new session: agent config changed');
      session = undefined;
    }

    // 1. Resume: send only what this agent has not seen yet.
    if (session) {
      const delta = selectDelta(threadMsgs, req.agentName, session.last_seen_seq, exclude);
      return {
        kind: 'resume',
        args: { resume: session.claude_session_id },
        prompt: join(renderUpdate(delta), message),
        cursor: maxSeq(delta, Math.max(triggerSeq, session.last_seen_seq)),
        markers,
        from: { threadId: thread.id, cwd: req.cwd },
      };
    }

    // 2. The thread moved: fork the agent's session from the previous directory, so it keeps its context.
    const before = store.latestSessionElsewhere(thread.id, req.agentName, req.cwd);
    if (before && before.flags_hash === hashAt(before.cwd)) {
      const delta = selectDelta(threadMsgs, req.agentName, before.last_seen_seq, exclude);
      markers.push(`moved to ${path.basename(req.cwd)}, session carried over`);
      return {
        kind: 'fork',
        args: { resume: before.claude_session_id, fork: true },
        prompt: join(renderUpdate(delta), renderMove(before.cwd, req.cwd), message),
        cursor: maxSeq(delta, Math.max(triggerSeq, before.last_seen_seq)),
        markers,
        from: { threadId: thread.id, cwd: before.cwd },
      };
    }

    // A channel made from a side thread still starts from its passage: an agent new to it forks or reads
    // the discussion the passage came from, like in the side thread.
    const originId = thread.parent_thread_id ?? thread.origin_thread_id;
    const isParagraph = !!originId && !!thread.parent_message_id;
    const source = isParagraph ? store.getMessage(thread.parent_message_id!) : undefined;
    const threadContext = isParagraph ? renderThreadContext(thread, source) : '';
    const priorInThread = threadMsgs.filter((m) => !exclude.includes(m.id));

    // 3. Paragraph thread whose parent thread has a session for this agent: fork it.
    if (isParagraph) {
      const parent = store.getSession(originId!, req.agentName, req.cwd);
      if (parent && parent.flags_hash === hash) {
        const parentMsgs = store.doneMessages(originId!, { uptoId: thread.parent_message_id! });
        const parentDelta = selectDelta(parentMsgs, req.agentName, parent.last_seen_seq);
        const sideSoFar = selectDelta(priorInThread, req.agentName, 0);
        markers.push(thread.origin_thread_id ? 'session forked from the conversation this channel grew out of' : 'thread session forked from the main conversation');
        return {
          kind: 'fork',
          args: { resume: parent.claude_session_id, fork: true },
          prompt: join(renderUpdate(parentDelta), threadContext, renderUpdate(sideSoFar, 'side_thread_so_far'), message),
          cursor: maxSeq(priorInThread, triggerSeq),
          markers,
          from: { threadId: originId!, cwd: req.cwd },
        };
      }
    }

    // 4. New session seeded with a transcript.
    let history: MessageRow[] = [];
    if (isParagraph) history = store.doneMessages(originId!, { uptoId: thread.parent_message_id! });
    history = history.concat(priorInThread);
    if (conversation.kind === 'routine' && !isParagraph) history = sinceLatestRunHeader(history, threadMsgs);
    const seed = renderSeed(history, req.agentName);
    const defaultCwd = conversation.dir ?? this.ctx.cfg.config.scratchDir;
    if (!markers.length) markers.push(req.cwd !== defaultCwd ? `new session in ${path.basename(req.cwd)}` : 'new session');
    return {
      kind: 'seed',
      args: {},
      prompt: join(seed.text, threadContext, message),
      cursor: maxSeq(priorInThread, triggerSeq),
      markers,
    };
  }
}

function join(...parts: string[]): string {
  return parts.filter((p) => p && p.trim()).join('\n\n');
}

/** Directories tagged for reference: named in the prompt only, so the spawn flags (and the cache) stay the same. */
export function renderDirRefs(dirs: string[] | undefined, cwd: string): string {
  if (!dirs?.length) return '';
  return `<referenced_directories>\nThe user points you at these directories. Your working directory is still ${cwd}; read them by absolute path.\n${dirs.map((d) => `- ${d}`).join('\n')}\n</referenced_directories>`;
}

export function renderMove(from: string, to: string): string {
  return `<working_directory_changed>\nThe user moved this conversation from ${from} to ${to}. You now run in ${to}; relative paths refer to it.\n</working_directory_changed>`;
}

export function renderThreadContext(thread: ThreadRow, source: MessageRow | undefined): string {
  const author = source ? (source.author_kind === 'agent' ? `agent:${source.author_id}` : source.author_kind === 'user' ? 'you' : 'the app') : 'unknown';
  const quoted = (thread.block_text ?? '')
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const n = thread.block_index != null && thread.block_end != null ? thread.block_end - thread.block_index + 1 : 1;
  const passage = n > 1 ? 'these passages' : 'this passage';
  const opened = thread.origin_thread_id
    ? `This channel grew out of a side thread the user opened on ${n > 1 ? `these ${n} consecutive passages` : passage}`
    : `The user opened a side thread on ${n > 1 ? `these ${n} consecutive passages` : passage}`;
  return `<thread_context>\n${opened} from an earlier message by ${author}:\n${quoted}\nFocus on ${passage}. The main discussion continues separately.\n</thread_context>`;
}

/** Routine channels: a new session only sees messages after the latest run header. */
function sinceLatestRunHeader(history: MessageRow[], all: MessageRow[]): MessageRow[] {
  const header = [...all].reverse().find((m) => m.author_kind === 'system' && m.meta && JSON.parse(m.meta).kind === 'run_header');
  if (!header) return history;
  return history.filter((m) => (m.done_seq ?? 0) > header.done_seq!);
}
