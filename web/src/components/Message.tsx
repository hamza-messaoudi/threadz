import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ChildThread, type Message as Msg, type Run, type ToolEvent } from '../lib/api.ts';
import { useSmoothText } from '../lib/useSmoothText.ts';
import { MarkdownBlocks, MessageMarkdown, useParsed } from '../markdown/MessageMarkdown.tsx';
import type { Block } from '../markdown/blocks.ts';
import { agentColor, useAppData } from '../lib/store.tsx';
import { tildify } from '../lib/dirs.ts';
import { navigate, parseRoute } from '../lib/router.ts';
import { MatrixLoader, ThinkingLine } from './motion.tsx';
import { Accordion, AccChevron, PopNumber, SuccessCheck, SwapText } from './transitions.tsx';
import { orderSteps, prettyTool, StepRow, StepsSummary, toolSummary, useAnchors, type Step } from './Steps.tsx';
import { ICONS } from './icons.tsx';
import { WorkflowCard } from './WorkflowCard.tsx';
import { editorName, revealEdit, withoutEdits } from '../lib/document.ts';
import { PencilSimple, Warning } from '@phosphor-icons/react';

export interface MessageProps {
  m: Msg;
  childThreads?: ChildThread[];
  run?: Run;
  /** The passage whose thread is open (highlighted). */
  activeRange?: BlockRange | null;
  /** Blocks picked for a new thread but not yet opened. */
  pendingRange?: BlockRange | null;
  onOpenThread?: (m: Msg, start: number, end?: number) => void;
  /** Shift-click on a block's thread button: grow the pending passage to that block. */
  onExtendPassage?: (m: Msg, blockIndex: number, at: DOMRect) => void;
  allowThreads?: boolean;
  flash?: boolean;
}

/** First and last block of a passage, inclusive. */
export interface BlockRange {
  start: number;
  end: number;
}

const within = (r: BlockRange | null | undefined, i: number) => !!r && r.start <= i && i <= r.end;

const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const MessageView = memo(function MessageView(props: MessageProps) {
  const { m } = props;
  if (m.authorKind === 'system') return <SystemMessage {...props} />;
  if (m.authorKind === 'user') return <UserMessage {...props} />;
  return <AgentMessage {...props} />;
});

function AgentMessage(props: MessageProps) {
  const { m } = props;
  const name = m.authorId ?? 'agent';
  const color = agentColor(m.authorId);
  const live = m.status === 'streaming' || m.status === 'queued';
  // A document edit being written is not text to read: the server applies it and the reply shows the result.
  const edit = useMemo(() => (live ? withoutEdits(m.content) : { text: m.content, drafting: null }), [live, m.content]);
  // The text as revealed so far: it runs a little behind the stream, at a steady pace.
  const smooth = useSmoothText(edit.text, m.status === 'streaming');
  // The status line stays until the text has caught up, then folds away and unmounts.
  const working = live || !smooth.done;
  const [statusMounted, setStatusMounted] = useState(working);
  if (working && !statusMounted) setStatusMounted(true);
  useEffect(() => {
    if (working || !statusMounted) return;
    const t = setTimeout(() => setStatusMounted(false), 600);
    return () => clearTimeout(t);
  }, [working, statusMounted]);

  return (
    <div className={`msg agent ${props.flash ? 'flash' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
      {m.markers.map((mk, i) => (
        <div key={i} className="marker">
          {mk}
        </div>
      ))}
      <div className="msg-head">
        <span className="msg-dot" style={{ background: color }} aria-hidden />
        <span className="msg-author" style={{ color }}>
          @{name}
        </span>
        <span className="msg-time">{time(m.createdAt)}</span>
        {m.status !== 'done' && (
          <span className={`msg-status ${m.status}`}>
            <SwapText text={statusLabel(m.status)} />
          </span>
        )}
        <CacheBadge m={m} />
        <span className="msg-actions">
          {live && (
            <button className="icon-btn" onClick={() => api.post(`/api/messages/${m.id}/cancel`)} data-tooltip="Stop this turn">
              ■ Stop
            </button>
          )}
          {m.sessionId && m.cwd && <TerminalButton m={m} />}
        </span>
      </div>
      <AgentBody {...props} smooth={smooth} />
      {/* Folds away rather than vanishing, so the text above does not jump when the turn ends. */}
      {statusMounted && (
        <Accordion open={working}>
          <AgentStatus m={m} drafting={edit.drafting} />
        </Accordion>
      )}
      {m.meta?.documentEdits && <EditResults m={m} />}
      {m.status === 'error' && <ErrorCard m={m} />}
    </div>
  );
}

/** Your messages sit in a frame on the right; the agents' replies are unframed. */
function UserMessage(props: MessageProps) {
  const { m } = props;
  return (
    <div className={`msg user ${props.flash ? 'flash' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
      <div className="user-bubble">
        <Body {...props} />
      </div>
      <div className="msg-meta">{time(m.createdAt)}</div>
    </div>
  );
}

/**
 * An agent's turn in the order it happened: thinking, text, tool calls, more text. Once the turn is
 * done, everything before the final answer folds into one "3 tool calls, 2 messages" row.
 */
function AgentBody(props: MessageProps & { smooth: { text: string; done: boolean } }) {
  const { m, childThreads, activeRange, pendingRange, smooth } = props;
  const live = m.status === 'streaming' || m.status === 'queued';
  const content = smooth.text;
  const streaming = m.status === 'streaming' || !smooth.done;
  const parsed = useParsed(m.id, content, streaming);
  const all = useMemo(() => orderSteps(m), [m.toolEvents, m.thinking]);
  // A step shows once the text written before it has.
  const steps = all.filter((s) => s.at <= content.length);
  const { anchors, ready } = useAnchors(m.id, content, steps.map((s) => s.at));
  const renderBlock = useBlockRenderer(props);
  const [open, setOpen] = useState<boolean | null>(null);

  const lastStep = steps.at(-1);
  const row = (s: Step) => <StepRow key={s.id} step={s} live={live && (s.kind === 'tool' || (s === lastStep && s.at === m.content.length))} />;

  // The whole reply could not be parsed: the text as written, steps first.
  if (!parsed && content && !streaming)
    return (
      <div className="msg-body">
        {steps.map(row)}
        <div className="md-body md-unparsed">{content}</div>
      </div>
    );
  // Measuring where the steps go takes a parse; a finished reply waits for it rather than jumping.
  if (!parsed || (!ready && !streaming)) {
    if (content && !streaming) return null;
    return steps.length ? <div className="msg-body">{steps.map(row)}</div> : null;
  }

  const total = parsed.blocks.length;
  type Unit = { kind: 'text'; from: number; to: number } | Step;
  const units: Unit[] = [];
  let at = 0;
  for (const s of steps) {
    const b = Math.min(anchors.get(s.at) ?? total, total);
    if (b > at) units.push({ kind: 'text', from: at, to: b });
    at = Math.max(at, b);
    units.push(s);
  }
  if (at < total) units.push({ kind: 'text', from: at, to: total });

  const text = (u: { from: number; to: number }) => (
    <MarkdownBlocks
      key={`b${u.from}`}
      parsed={{ tree: parsed.tree, blocks: parsed.blocks.slice(u.from, u.to) }}
      total={total}
      streaming={streaming && u.to === total}
      renderBlock={renderBlock}
    />
  );
  const unit = (u: Unit) => (u.kind === 'text' ? text(u) : row(u));

  // Fold the steps once the turn has a final answer after its last tool call.
  const final = units.at(-1);
  const tools = steps.flatMap((s) => (s.kind === 'tool' ? [s.tool] : []));
  if (m.status !== 'done' || streaming || !tools.length || final?.kind !== 'text') return <div className="msg-body">{units.map(unit)}</div>;

  const before = units.slice(0, -1);
  const cut = final.from;
  // A thread or picked passage in the folded text keeps it open.
  const touched =
    (childThreads ?? []).some((t) => t.parentMessageId === m.id && t.blockIndex < cut) || (activeRange && activeRange.start < cut) || (pendingRange && pendingRange.start < cut);
  const isOpen = open ?? !!touched;
  return (
    <div className="msg-body">
      <StepsSummary tools={tools} messages={before.filter((u) => u.kind === 'text').length} open={isOpen} onToggle={() => setOpen(!isOpen)} />
      <Accordion open={isOpen}>
        <div className="steps-group">{before.map(unit)}</div>
      </Accordion>
      {text(final)}
    </div>
  );
}

/** While a turn is queued or running: a matrix loader and a status line that follows the tool calls. */
function AgentStatus({ m, drafting }: { m: Msg; drafting: string | null }) {
  // Whichever grew last, the text or the tool list, says what the agent is doing now.
  const seen = useRef({ tools: m.toolEvents.length, text: m.content.length, last: 'none' as 'none' | 'tool' | 'text' });
  if (m.toolEvents.length !== seen.current.tools) seen.current = { ...seen.current, tools: m.toolEvents.length, last: 'tool' };
  if (m.content.length !== seen.current.text) seen.current = { ...seen.current, text: m.content.length, last: 'text' };
  const running = [...m.toolEvents].reverse().find((t) => t.output_preview === undefined);
  // The first thread on a long document reads it once before answering (server: READING_MARKER).
  const reading = m.status === 'streaming' && !m.content && m.markers.some((mk) => mk.startsWith('reading '));
  const text =
    m.status === 'queued'
      ? 'Waiting for a free slot…'
      : reading
        ? 'Reading the document…'
        : drafting
        ? `Editing ${drafting}…`
        : running
        ? toolActivity(running)
        : seen.current.last === 'text' || (seen.current.last === 'none' && m.content)
          ? 'Writing…'
          : 'Thinking…';
  return (
    <div className="agent-status">
      <MatrixLoader variant={m.status === 'queued' ? 'pulse' : running ? 'orbit' : 'scan'} rounded={m.status === 'queued'} />
      <ThinkingLine text={text} className="agent-status-line" />
    </div>
  );
}

const VERBS: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Bash: 'Running',
  Grep: 'Searching for',
  Glob: 'Finding',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web for',
  Agent: 'Delegating:',
  Task: 'Delegating:',
  TodoWrite: 'Planning',
  ToolSearch: 'Loading tools',
};

/** "Reading app/server.ts", "Running npm test", "github · list_prs …" */
export function toolActivity(t: ToolEvent): string {
  const verb = VERBS[t.name];
  let arg = toolSummary(t);
  if (t.name === 'Read' || t.name === 'Edit' || t.name === 'Write' || t.name === 'MultiEdit') arg = arg.split('/').slice(-2).join('/');
  if (t.name === 'TodoWrite' || t.name === 'ToolSearch') arg = '';
  arg = arg.replace(/\s+/g, ' ');
  if (arg.length > 80) arg = arg.slice(0, 80) + '…';
  return `${verb ?? prettyTool(t.name)}${arg ? ' ' + arg : ''}${verb ? '' : '…'}`;
}

function statusLabel(s: Msg['status']) {
  return s === 'streaming' ? 'working' : s;
}

function Body(props: MessageProps) {
  const { m } = props;
  const renderBlock = useBlockRenderer(props);
  if (!m.content) return null;
  return (
    <div className="msg-body">
      <MessageMarkdown id={m.id} content={m.content} streaming={m.status === 'streaming'} renderBlock={renderBlock} />
    </div>
  );
}

/**
 * Wraps each block with its thread controls: the reply gutter, the rail, the reply badge. The function
 * keeps its identity until one of those changes, so memoised block lists (a document) skip re-renders.
 */
export function useBlockRenderer({ m, childThreads, activeRange, pendingRange, onOpenThread, onExtendPassage, allowThreads }: MessageProps, extra?: (b: Block) => ReactNode) {
  const threads = useMemo(() => (childThreads ?? []).filter((t) => t.parentMessageId === m.id), [childThreads, m.id]);
  const canThread = allowThreads && m.status === 'done' && !!onOpenThread;
  return useCallback((b: Block, content: ReactNode) => {
    const i = b.index;
    const covering = threads.filter((t) => t.blockIndex <= i && i <= t.blockEnd);
    // A block inside a multi-paragraph passage joins the rail of the block above it; a pending pick draws over threads.
    const join = within(pendingRange, i) && pendingRange!.start < i ? 'pending-join' : covering.some((t) => t.blockIndex < i) ? 'rail-join' : '';
    // Clicking a quoted block opens the tightest passage around it.
    const tightest = covering.reduce<ChildThread | undefined>((a, t) => (!a || t.blockEnd - t.blockIndex < a.blockEnd - a.blockIndex ? t : a), undefined);
    const ending = covering.filter((t) => t.blockEnd === i);
    const cls = ['block', covering.length && 'has-thread', within(activeRange, i) && 'active-source', within(pendingRange, i) && 'pending-passage', join];
    return (
      <div
        data-block={i}
        className={cls.filter(Boolean).join(' ')}
        onClick={tightest && onOpenThread ? (e) => !window.getSelection()?.toString() && !(e.target as HTMLElement).closest('a, button') && onOpenThread(m, tightest.blockIndex, tightest.blockEnd) : undefined}
      >
        {canThread && (
          <button
            className="block-gutter"
            data-tooltip="Reply in thread · ⇧-click another to span paragraphs"
            aria-label="Reply in thread"
            onMouseDown={(e) => {
              // Shift would extend the browser's text selection, and the list would clear the pending passage.
              if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey && onExtendPassage) onExtendPassage(m, i, e.currentTarget.getBoundingClientRect());
              else onOpenThread!(m, i);
            }}
          >
            {ICONS.thread}
          </button>
        )}
        {content}
        {extra?.(b)}
        {ending.map((t) => (
          <button
            key={t.id}
            className={`thread-badge ${t.channel ? 'to-channel' : ''}`}
            data-tooltip={t.channel ? `This thread became #${t.channel.name}` : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (t.channel) navigate({ view: 'conversation', conversationId: t.channel.id });
              else onOpenThread?.(m, t.blockIndex, t.blockEnd);
            }}
          >
            <span className="thread-badge-icon">{t.channel ? ICONS.hash : ICONS.reply}</span>
            {t.channel ? (
              <span className="thread-badge-field">{t.channel.name}</span>
            ) : (
              <span className="thread-badge-count">
                <PopNumber value={t.replyCount} /> {t.replyCount === 1 ? 'reply' : 'replies'}
              </span>
            )}
            {t.blockEnd > t.blockIndex && <span className="thread-badge-meta">{t.blockEnd - t.blockIndex + 1} paragraphs</span>}
            {t.anchor === 'changed' && (
              <span className="thread-badge-meta thread-badge-changed" data-tooltip={`Version ${t.anchorVersion} changed this passage after the thread began`}>
                passage edited
              </span>
            )}
            <span className="thread-badge-meta">{relTime(t.lastActivity)}</span>
          </button>
        ))}
      </div>
    );
  }, [m, threads, canThread, activeRange, pendingRange, onOpenThread, onExtendPassage, extra]);
}

export function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function CacheBadge({ m }: { m: Msg }) {
  const u = m.usage;
  if (!u) return null;
  const f = u.first_call ?? u;
  const read = f.cache_read_input_tokens ?? 0;
  const create = f.cache_creation_input_tokens ?? 0;
  const input = f.input_tokens ?? 0;
  const total = read + create + input;
  if (!total) return null;
  const pct = Math.round((read / total) * 100);
  const title = [
    `First API call of this turn: ${read.toLocaleString()} cache read, ${create.toLocaleString()} cache write, ${input.toLocaleString()} uncached input`,
    `Whole turn: ${(u.cache_read_input_tokens ?? 0).toLocaleString()} read, ${(u.cache_creation_input_tokens ?? 0).toLocaleString()} write, ${(u.input_tokens ?? 0).toLocaleString()} input, ${(u.output_tokens ?? 0).toLocaleString()} output`,
    u.reader
      ? `Read the document first, once for all its threads: ${(u.reader.cache_read_input_tokens ?? 0).toLocaleString()} read, ${(u.reader.cache_creation_input_tokens ?? 0).toLocaleString()} write${u.reader.total_cost_usd ? `, $${u.reader.total_cost_usd.toFixed(4)}` : ''}`
      : '',
    u.total_cost_usd ? `Cost: $${u.total_cost_usd.toFixed(4)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`cache-badge ${pct >= 80 ? 'hit' : pct < 30 ? 'miss' : ''}`} title={title}>
      cache <PopNumber value={pct} />%
    </span>
  );
}

function StepPrompt({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  return (
    <Accordion
      open={open}
      className="step-prompt"
      head={
        <button className="step-head t-acc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          {m.authorId} · step {m.meta.step} prompt for @{m.meta.agent} <AccChevron />
        </button>
      }
    >
      <pre>{m.content}</pre>
    </Accordion>
  );
}

function TerminalButton({ m }: { m: Msg }) {
  const { config } = useAppData();
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(0), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const cmd = `cd '${m.cwd!.replace(/'/g, `'\\''`)}' && ${config?.claudeBin ?? 'claude'} --resume ${m.sessionId}`;
  return (
    <button
      className="icon-btn"
      title={cmd}
      onClick={async () => {
        await navigator.clipboard.writeText(cmd);
        setCopied(Date.now());
      }}
    >
      {copied > 0 && <SuccessCheck play={copied} key={copied} />}
      <SwapText text={copied ? 'Copied' : 'Open in terminal'} />
    </button>
  );
}

function ErrorCard({ m }: { m: Msg }) {
  const [first, ...rest] = (m.error ?? 'Unknown error').split('\n');
  const routine = m.meta?.routine as string | undefined;
  return (
    <div className="msg-error">
      <strong>{first}</strong>
      {rest.length > 0 && <pre>{rest.join('\n')}</pre>}
      {routine && (
        <div className="row gap" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => api.post(`/api/routines/${encodeURIComponent(routine)}/run`)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function SystemMessage({ m, run }: MessageProps) {
  const kind = m.meta?.kind;
  if (kind === 'run_header') return <div className="run-header">{m.content}</div>;
  if (kind === 'routine_error')
    return (
      <div className="system-msg">
        <ErrorCard m={m} />
      </div>
    );
  if (kind === 'workflow_card') return <WorkflowCard m={m} run={run} />;
  if (kind === 'moved') return <MovedNote to={m.meta.to} />;
  if (kind === 'promoted') return <PromotedNote m={m} />;
  if (kind === 'merged') return <MergedNote m={m} />;
  if (kind === 'document_edit') return <DocEditNote m={m} />;
  if (kind === 'workflow_step')
    return (
      <StepPrompt m={m} />
    );
  return <div className="system-msg">{m.content}</div>;
}

function MovedNote({ to }: { to: string }) {
  const { config } = useAppData();
  return (
    <div className="system-msg moved">
      → Moved to <code>{tildify(to, config?.homeDir)}</code>. Replies run there from now on.
    </div>
  );
}

/** What an agent's reply did to a shared document: the new version, or why its edit was not applied. */
function EditResults({ m }: { m: Msg }) {
  const results = m.meta.documentEdits as { name: string; documentId: string | null; status: 'applied' | 'unchanged' | 'failed'; version?: number; rebased?: boolean; error?: string }[];
  return (
    <div className="edit-results">
      {results.map((r, i) =>
        r.status === 'failed' ? (
          <div key={i} className="edit-result failed">
            <Warning size={15} aria-hidden />
            <span>
              Could not edit <strong>{r.name}</strong>: {r.error}
            </span>
          </div>
        ) : (
          <div key={i} className="edit-result">
            <PencilSimple size={15} aria-hidden />
            <span>
              {r.status === 'unchanged' ? (
                <>
                  Left <strong>{r.name}</strong> as it was
                </>
              ) : (
                <>
                  Edited <strong>{r.name}</strong> · version {r.version}
                  {r.rebased && <span className="muted"> · on top of an edit made meanwhile</span>}
                </>
              )}
            </span>
            {r.status === 'applied' && r.documentId && (
              <button className="link" onClick={() => revealEdit(r.documentId!, r.version)}>
                Show
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

/** In the timeline where a document was edited: by whom, which version, from where, and what it did to threads. */
function DocEditNote({ m }: { m: Msg }) {
  const meta = m.meta as { documentId: string; name: string; version: number; by: { kind: 'user' | 'agent'; id: string | null }; threadId: string | null; restored: number | null; threads?: { changed: number; removed: number } };
  const moved = meta.threads ?? { changed: 0, removed: 0 };
  const effects = [
    moved.changed ? `${moved.changed} ${moved.changed === 1 ? 'thread’s passage' : 'threads’ passages'} changed` : '',
    moved.removed ? `${moved.removed} ${moved.removed === 1 ? 'thread' : 'threads'} detached` : '',
  ].filter(Boolean);
  return (
    <div className="system-msg doc-edit-note">
      <PencilSimple size={14} aria-hidden />
      <span>
        <span className="doc-edit-who" style={meta.by.kind === 'agent' ? { color: agentColor(meta.by.id) } : undefined}>
          {editorName(meta.by)}
        </span>{' '}
        {meta.restored ? `restored version ${meta.restored} of` : 'edited'} <strong>{meta.name}</strong>
        <span className="muted"> · version {meta.version}</span>
        {meta.threadId && (
          <>
            {' · '}
            <button className="link" onClick={() => navigate({ view: 'conversation', conversationId: parseRoute().conversationId, threadId: meta.threadId! })}>
              from a thread
            </button>
          </>
        )}
        {effects.length > 0 && <span className="muted"> · {effects.join(', ')}</span>}
        {' · '}
        <button className="link" onClick={() => revealEdit(meta.documentId, meta.version)}>
          Show
        </button>
      </span>
    </div>
  );
}

/** Marks where a pick grew this thread over more paragraphs (and folded other threads in). */
function MergedNote({ m }: { m: Msg }) {
  const n = m.meta.threads as number;
  const span = m.meta.end > m.meta.start ? `paragraphs ${m.meta.start + 1}–${m.meta.end + 1}` : `paragraph ${m.meta.start + 1}`;
  return (
    <div className="system-msg promoted">
      <span className="promoted-rule" />
      <span>
        {n ? `Merged ${n === 1 ? 'a thread' : `${n} threads`} in` : 'Passage widened'} · now {span}
      </span>
      <span className="promoted-rule" />
    </div>
  );
}

/** Marks where a side thread became its own channel; earlier replies were the thread. */
function PromotedNote({ m }: { m: Msg }) {
  const from = m.meta.from as { conversationId: string; name: string; kind: string } | undefined;
  return (
    <div className="system-msg promoted">
      <span className="promoted-rule" />
      <span>
        Became a channel
        {from && (
          <>
            {' · thread started in '}
            <button className="link" onClick={() => navigate({ view: 'conversation', conversationId: from.conversationId })}>
              {from.kind === 'chat' ? from.name : `#${from.name}`}
            </button>
          </>
        )}
      </span>
      <span className="promoted-rule" />
    </div>
  );
}
