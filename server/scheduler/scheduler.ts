import fs from 'node:fs';
import type { AppContext } from '../app.ts';
import type { RoutineDef } from '../config/types.ts';
import { serializeConversation, serializeMessage } from '../core/serialize.ts';
import type { ConversationRow } from '../db/queries.ts';
import { isDue, lastSlot, nextSlot } from './due.ts';

export type RoutineStatus = 'ok' | 'running' | 'error' | 'pending';

/**
 * Runs each due routine once per slot, one at a time. Automatic attempts happen at most once per slot
 * per server process; a failed slot is retried only by the Retry button or the next app start.
 */
export class Scheduler {
  private attempted = new Set<string>();
  private queue: { name: string; manual: boolean }[] = [];
  private active: string | null = null;
  private timer?: NodeJS.Timeout;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle?: () => void;

  constructor(
    private readonly ctx: AppContext,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.check();
    const every = () => this.ctx.cfg.config.routineCheckMinutes * 60_000;
    const tick = () => {
      this.check();
      this.timer = setTimeout(tick, every());
    };
    this.timer = setTimeout(tick, every());
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Enqueues every routine whose latest slot has not succeeded and was not tried in this process. */
  check(): void {
    const now = this.now();
    for (const r of Object.values(this.ctx.cfg.routines)) {
      const key = `${r.name}:${lastSlot(r.schedule, now)}`;
      if (this.attempted.has(key)) continue;
      if (!isDue(this.ctx.store.getRoutineState(r.name), r.schedule, now)) continue;
      this.attempted.add(key);
      this.enqueue(r.name, false);
    }
  }

  /** Manual run / Retry. Returns false when the routine is already queued or running. */
  enqueue(name: string, manual = true): boolean {
    if (this.active === name || this.queue.some((q) => q.name === name)) return false;
    this.queue.push({ name, manual });
    this.ctx.hub.global('routine.status', { name });
    if (!this.resolveIdle) this.idle = new Promise((r) => (this.resolveIdle = r));
    void this.pump();
    return true;
  }

  /** Resolves when the queue is empty (tests). */
  whenIdle(): Promise<void> {
    return this.idle;
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) {
      this.resolveIdle?.();
      this.resolveIdle = undefined;
      return;
    }
    this.active = next.name;
    try {
      await this.runRoutine(next.name, next.manual);
    } catch (e) {
      console.error(`routine ${next.name} crashed`, e);
    } finally {
      this.active = null;
      this.ctx.hub.global('routine.status', { name: next.name });
      void this.pump();
    }
  }

  ensureChannel(r: RoutineDef): ConversationRow {
    const { store, hub } = this.ctx;
    let conv = store.getRoutineConversation(r.name);
    if (!conv) {
      conv = store.createConversation({ kind: 'routine', name: r.channel, dir: r.dir ?? null, yolo: r.yolo, routineId: r.name }).conversation;
    } else {
      store.updateConversation(conv.id, { name: r.channel, dir: r.dir ?? null, yolo: r.yolo ? 1 : 0 });
      conv = store.getConversation(conv.id)!;
    }
    hub.global('conversation.updated', serializeConversation({ ...conv, root_thread_id: store.rootThread(conv.id).id }));
    return conv;
  }

  private async runRoutine(name: string, manual: boolean): Promise<boolean> {
    const { store, hub, cfg } = this.ctx;
    const r = cfg.routines[name];
    if (!r) return false;
    const slot = lastSlot(r.schedule, this.now());
    const prev = store.getRoutineState(name);
    const fail = (error: string): false => {
      store.saveRoutineState({ routine_id: name, last_success_slot: prev?.last_success_slot ?? null, last_attempt_at: Date.now(), last_error: error });
      return false;
    };

    const conv = this.ensureChannel(r);
    const thread = store.rootThread(conv.id);
    // Fresh sessions: today's run must not replay yesterday's conversation.
    store.deleteThreadSessions(thread.id);
    const kind = manual ? 'Manual run' : 'daily' in r.schedule ? 'Daily run' : 'Weekly run';
    const date = new Date(this.now()).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const header = store.insertMessage({
      thread_id: thread.id,
      author_kind: 'system',
      author_id: name,
      content_md: `${kind} · ${date}`,
      status: 'done',
      meta: { kind: 'run_header', routine: name, slot },
    });
    hub.thread(thread.id, 'message.created', serializeMessage(header));

    const cwd = r.dir ?? this.ctx.scratchDir();
    if (!fs.existsSync(cwd)) return this.postError(thread.id, name, `routine directory does not exist: ${cwd}`, fail);

    let ok: boolean;
    let error = '';
    if (r.target.kind === 'agent') {
      const turn = this.ctx.runner.start({
        threadId: thread.id,
        agentName: r.target.id,
        cwd,
        trigger: { seq: header.done_seq!, text: r.prompt, from: `routine:${name}` },
        meta: { routine: name },
      });
      const outcome = await turn.done;
      ok = outcome.status === 'done';
      error = outcome.error ?? outcome.status;
    } else {
      const run = this.ctx.workflows.start({ workflow: r.target.id, thread, trigger: null, cwd, mentions: null, input: r.prompt });
      ok = await this.ctx.workflows.wait(run.id);
      if (!ok) {
        error = store.getRun(run.id)?.error ?? 'workflow failed';
        return this.postError(thread.id, name, error, fail);
      }
    }
    if (!ok) return fail(error);
    store.saveRoutineState({ routine_id: name, last_success_slot: slot, last_attempt_at: Date.now(), last_error: null });
    return true;
  }

  private postError(threadId: string, name: string, error: string, fail: (e: string) => false): false {
    const msg = this.ctx.store.insertMessage({
      thread_id: threadId,
      author_kind: 'system',
      author_id: name,
      content_md: '',
      status: 'error',
      error: `Routine failed\n${error}`,
      meta: { kind: 'routine_error', routine: name },
    });
    this.ctx.hub.thread(threadId, 'message.created', serializeMessage(msg));
    return fail(error);
  }

  status(name: string): RoutineStatus {
    if (this.active === name || this.queue.some((q) => q.name === name)) return 'running';
    const st = this.ctx.store.getRoutineState(name);
    if (!st) return 'pending';
    if (st.last_error) return 'error';
    return 'ok';
  }

  list() {
    const now = this.now();
    return Object.values(this.ctx.cfg.routines).map((r) => {
      const st = this.ctx.store.getRoutineState(r.name);
      return {
        name: r.name,
        schedule: r.schedule,
        channel: r.channel,
        target: `${r.target.kind}:${r.target.id}`,
        dir: r.dir,
        yolo: r.yolo,
        status: this.status(r.name),
        nextSlot: nextSlot(r.schedule, now),
        lastSuccessSlot: st?.last_success_slot ?? null,
        lastError: st?.last_error ?? null,
        conversationId: this.ctx.store.getRoutineConversation(r.name)?.id ?? null,
      };
    });
  }
}
