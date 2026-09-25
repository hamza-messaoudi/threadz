import { monotonicFactory } from 'ulid';
import type { DB } from './migrate.ts';

export const ulid = monotonicFactory();

export type ConversationKind = 'channel' | 'chat' | 'routine';
export type AuthorKind = 'user' | 'agent' | 'system';
export type MessageStatus = 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

export interface ConversationRow {
  id: string;
  kind: ConversationKind;
  name: string;
  dir: string | null;
  yolo: number;
  routine_id: string | null;
  archived: number;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  conversation_id: string;
  parent_thread_id: string | null;
  parent_message_id: string | null;
  block_index: number | null;
  block_end: number | null;
  block_text: string | null;
  /** Set by a move; NULL = inherit (see threadCwd). */
  dir: string | null;
  /** Set when a side thread became its own channel: the thread it was opened from. */
  origin_thread_id: string | null;
  created_at: number;
}

export interface MessageRow {
  rowid?: number;
  id: string;
  thread_id: string;
  author_kind: AuthorKind;
  author_id: string | null;
  content_md: string;
  tool_events: string | null;
  status: MessageStatus;
  error: string | null;
  usage: string | null;
  run_id: string | null;
  done_seq: number | null;
  created_at: number;
  cwd: string | null;
  session_id: string | null;
  markers: string | null;
  mentions: string | null;
  meta: string | null;
}

export interface SessionRow {
  thread_id: string;
  agent_id: string;
  cwd: string;
  claude_session_id: string;
  last_seen_seq: number;
  flags_hash: string;
  updated_at: number;
  /** Context to send once ahead of the next turn (see 005-session-pending.sql). */
  pending: string | null;
}

/** A document's reader session (see 006-document-sessions.sql). */
export interface ReaderSessionRow {
  message_id: string;
  agent_id: string;
  cwd: string;
  claude_session_id: string;
  flags_hash: string;
  created_at: number;
}

export interface RunRow {
  id: string;
  kind: 'turn' | 'workflow' | 'routine';
  status: string;
  parent_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  thread_id: string | null;
  meta: string | null;
}

export interface RoutineStateRow {
  routine_id: string;
  last_success_slot: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

export interface NewMessage {
  thread_id: string;
  author_kind: AuthorKind;
  author_id?: string | null;
  content_md?: string;
  status: MessageStatus;
  run_id?: string | null;
  cwd?: string | null;
  markers?: string[] | null;
  mentions?: unknown;
  meta?: unknown;
  error?: string | null;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export class Store {
  constructor(readonly db: DB) {}

  // ---- conversations ----

  createConversation(input: {
    kind: ConversationKind;
    name: string;
    dir?: string | null;
    yolo?: boolean;
    routineId?: string | null;
  }): { conversation: ConversationRow; rootThreadId: string } {
    const now = Date.now();
    const id = ulid();
    const threadId = ulid();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversations (id, kind, name, dir, yolo, routine_id, archived, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, input.kind, input.name, input.dir ?? null, input.yolo ? 1 : 0, input.routineId ?? null, now);
      this.db
        .prepare(`INSERT INTO threads (id, conversation_id, created_at) VALUES (?, ?, ?)`)
        .run(threadId, id, now);
    })();
    return { conversation: this.getConversation(id)!, rootThreadId: threadId };
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  }

  getRoutineConversation(routineId: string): ConversationRow | undefined {
    return this.db
      .prepare(`SELECT * FROM conversations WHERE kind = 'routine' AND routine_id = ? ORDER BY created_at LIMIT 1`)
      .get(routineId) as ConversationRow | undefined;
  }

  listConversations(): (ConversationRow & { root_thread_id: string; last_activity: number })[] {
    return this.db
      .prepare(
        `SELECT c.*, t.id AS root_thread_id,
                COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id), c.created_at) AS last_activity
         FROM conversations c JOIN threads t ON t.conversation_id = c.id AND t.parent_thread_id IS NULL
         WHERE c.archived = 0
         ORDER BY c.kind, c.name COLLATE NOCASE`,
      )
      .all() as any;
  }

  updateConversation(id: string, patch: Partial<Pick<ConversationRow, 'name' | 'dir' | 'yolo' | 'archived'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE conversations SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  // ---- threads ----

  rootThread(conversationId: string): ThreadRow {
    return this.db
      .prepare(`SELECT * FROM threads WHERE conversation_id = ? AND parent_thread_id IS NULL`)
      .get(conversationId) as ThreadRow;
  }

  getThread(id: string): ThreadRow | undefined {
    return this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
  }

  /** Upsert on (parent_message_id, block_index, block_end); returns the thread and whether it was created. */
  upsertParagraphThread(message: MessageRow, blockIndex: number, blockText: string, blockEnd = blockIndex): { thread: ThreadRow; created: boolean } {
    const existing = this.db
      .prepare(`SELECT * FROM threads WHERE parent_message_id = ? AND block_index = ? AND block_end = ?`)
      .get(message.id, blockIndex, blockEnd) as ThreadRow | undefined;
    if (existing) return { thread: existing, created: false };
    const parent = this.getThread(message.thread_id)!;
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO threads (id, conversation_id, parent_thread_id, parent_message_id, block_index, block_end, block_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, parent.conversation_id, parent.id, message.id, blockIndex, blockEnd, blockText, Date.now());
    return { thread: this.getThread(id)!, created: true };
  }

  /**
   * Turns a side thread into the root thread of a new channel. The thread keeps its id, so its messages,
   * agent sessions and delta cursors carry over as they are; only its place in the tree changes.
   */
  promoteThread(threadId: string, input: { name: string; dir: string | null; yolo: boolean }): ConversationRow {
    const id = ulid();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO conversations (id, kind, name, dir, yolo, routine_id, archived, created_at) VALUES (?, 'channel', ?, ?, ?, NULL, 0, ?)`)
        .run(id, input.name, input.dir, input.yolo ? 1 : 0, Date.now());
      this.db
        .prepare(`UPDATE threads SET conversation_id = ?, origin_thread_id = parent_thread_id, parent_thread_id = NULL, dir = NULL WHERE id = ?`)
        .run(id, threadId);
    })();
    return this.getConversation(id)!;
  }

  /** Side threads quoting blocks of this message (channels made from them included). */
  threadsOnMessage(messageId: string): ThreadRow[] {
    return this.db.prepare(`SELECT * FROM threads WHERE parent_message_id = ? ORDER BY block_index`).all(messageId) as ThreadRow[];
  }

  /** Whether a turn is queued or running in the thread. */
  threadBusy(threadId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM messages WHERE thread_id = ? AND status IN ('queued', 'streaming') LIMIT 1`).get(threadId);
  }

  /**
   * Folds side threads into `into`, which then quotes blocks start..end. Their messages and runs move
   * over (ids are time-ordered, so the replies interleave); `sessions` are the agent sessions `into`
   * keeps from now on, all others of these threads are dropped.
   */
  mergeThreads(into: string, absorbed: string[], passage: { start: number; end: number; text: string }, sessions: SessionRow[]): void {
    const all = [into, ...absorbed];
    const q = all.map(() => '?').join(', ');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_sessions WHERE thread_id IN (${q})`).run(...all);
      for (const id of absorbed) {
        this.db.prepare(`UPDATE messages SET thread_id = ? WHERE thread_id = ?`).run(into, id);
        this.db.prepare(`UPDATE runs SET thread_id = ? WHERE thread_id = ?`).run(into, id);
        this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
      }
      this.db.prepare(`UPDATE threads SET block_index = ?, block_end = ?, block_text = ? WHERE id = ?`).run(passage.start, passage.end, passage.text, into);
      const put = this.db.prepare(
        `INSERT INTO agent_sessions (thread_id, agent_id, cwd, claude_session_id, last_seen_seq, flags_hash, updated_at, pending)
         VALUES (@thread_id, @agent_id, @cwd, @claude_session_id, @last_seen_seq, @flags_hash, @updated_at, @pending)`,
      );
      for (const s of sessions) put.run({ ...s, thread_id: into });
    })();
  }

  /** Empties a side thread: its replies, runs and agent sessions go; with `drop`, the thread itself too. */
  clearThread(id: string, drop = false): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_sessions WHERE thread_id = ?`).run(id);
      this.db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(id);
      this.db.prepare(`DELETE FROM runs WHERE thread_id = ?`).run(id);
      if (drop) this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    })();
  }

  setThreadDir(id: string, dir: string | null): void {
    this.db.prepare(`UPDATE threads SET dir = ? WHERE id = ?`).run(dir, id);
  }

  /** Side threads opened from this thread, including those since turned into channels (channel_id set). */
  childThreadSummaries(threadId: string) {
    return this.db
      .prepare(
        `SELECT t.id, t.parent_message_id, t.block_index, t.block_end, t.created_at,
                COUNT(m.id) AS reply_count, MAX(m.created_at) AS last_activity,
                CASE WHEN t.origin_thread_id IS NULL THEN NULL ELSE c.id END AS channel_id,
                CASE WHEN t.origin_thread_id IS NULL THEN NULL ELSE c.name END AS channel_name
         FROM threads t
         JOIN conversations c ON c.id = t.conversation_id
         LEFT JOIN messages m ON m.thread_id = t.id AND m.author_kind != 'system'
         WHERE t.parent_thread_id = @id OR t.origin_thread_id = @id
         GROUP BY t.id`,
      )
      .all({ id: threadId }) as {
      id: string;
      parent_message_id: string;
      block_index: number;
      block_end: number;
      created_at: number;
      reply_count: number;
      last_activity: number | null;
      channel_id: string | null;
      channel_name: string | null;
    }[];
  }

  // ---- messages ----

  insertMessage(m: NewMessage): MessageRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, author_kind, author_id, content_md, status, run_id, created_at, cwd, markers, mentions, meta, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.thread_id,
        m.author_kind,
        m.author_id ?? null,
        m.content_md ?? '',
        m.status === 'done' ? 'streaming' : m.status,
        m.run_id ?? null,
        Date.now(),
        m.cwd ?? null,
        m.markers?.length ? json(m.markers) : null,
        json(m.mentions),
        json(m.meta),
        m.error ?? null,
      );
    if (m.status === 'done') this.markDone(id);
    return this.getMessage(id)!;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT rowid, * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }

  listMessages(threadId: string): MessageRow[] {
    return this.db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id`).all(threadId) as MessageRow[];
  }

  updateMessage(
    id: string,
    patch: Partial<Pick<MessageRow, 'content_md' | 'tool_events' | 'status' | 'error' | 'usage' | 'cwd' | 'session_id' | 'markers' | 'meta' | 'run_id'>>,
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE messages SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  /** Sets status to done and assigns the next monotonic done_seq. */
  markDone(id: string): number {
    this.db
      .prepare(
        `UPDATE messages SET status = 'done', done_seq = (SELECT COALESCE(MAX(done_seq), 0) + 1 FROM messages)
         WHERE id = ? AND done_seq IS NULL`,
      )
      .run(id);
    return (this.db.prepare(`SELECT done_seq FROM messages WHERE id = ?`).get(id) as { done_seq: number }).done_seq;
  }

  maxSeq(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(done_seq), 0) AS s FROM messages`).get() as { s: number }).s;
  }

  /** Name of the agent that most recently replied in this thread. */
  lastAgentInThread(threadId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT author_id FROM messages WHERE thread_id = ? AND author_kind = 'agent' AND status != 'cancelled'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(threadId) as { author_id: string } | undefined;
    return row?.author_id ?? null;
  }

  /** Done messages in a thread, ordered by done_seq. */
  doneMessages(threadId: string, opts: { afterSeq?: number; uptoId?: string } = {}): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE thread_id = @threadId AND status = 'done' AND done_seq > @afterSeq
           AND (@uptoId IS NULL OR id <= @uptoId)
         ORDER BY done_seq`,
      )
      .all({ threadId, afterSeq: opts.afterSeq ?? 0, uptoId: opts.uptoId ?? null }) as MessageRow[];
  }

  unfinishedMessages(): MessageRow[] {
    return this.db.prepare(`SELECT * FROM messages WHERE status IN ('queued', 'streaming')`).all() as MessageRow[];
  }

  // ---- sessions ----

  getSession(threadId: string, agentId: string, cwd: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND cwd = ?`)
      .get(threadId, agentId, cwd) as SessionRow | undefined;
  }

  /** Writing a session means its turn started, so any pending context has been sent: it is cleared. */
  upsertSession(s: Omit<SessionRow, 'updated_at' | 'pending'>): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions (thread_id, agent_id, cwd, claude_session_id, last_seen_seq, flags_hash, updated_at)
         VALUES (@thread_id, @agent_id, @cwd, @claude_session_id, @last_seen_seq, @flags_hash, @updated_at)
         ON CONFLICT (thread_id, agent_id, cwd) DO UPDATE SET
           claude_session_id = excluded.claude_session_id, last_seen_seq = excluded.last_seen_seq,
           flags_hash = excluded.flags_hash, updated_at = excluded.updated_at, pending = NULL`,
      )
      .run({ ...s, updated_at: Date.now() });
  }

  clearPending(threadId: string, agentId: string, cwd: string): void {
    this.db.prepare(`UPDATE agent_sessions SET pending = NULL WHERE thread_id = ? AND agent_id = ? AND cwd = ?`).run(threadId, agentId, cwd);
  }

  threadSessions(threadId: string): SessionRow[] {
    return this.db.prepare(`SELECT * FROM agent_sessions WHERE thread_id = ? ORDER BY updated_at DESC`).all(threadId) as SessionRow[];
  }

  /** The agent's most recently used session in this thread in another directory (before a move). */
  latestSessionElsewhere(threadId: string, agentId: string, cwd: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND cwd != ? ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, agentId, cwd) as SessionRow | undefined;
  }

  deleteSession(threadId: string, agentId: string, cwd: string): void {
    this.db.prepare(`DELETE FROM agent_sessions WHERE thread_id = ? AND agent_id = ? AND cwd = ?`).run(threadId, agentId, cwd);
  }

  deleteThreadSessions(threadId: string): void {
    this.db.prepare(`DELETE FROM agent_sessions WHERE thread_id = ?`).run(threadId);
  }

  getReaderSession(messageId: string, agentId: string, cwd: string): ReaderSessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM document_sessions WHERE message_id = ? AND agent_id = ? AND cwd = ?`)
      .get(messageId, agentId, cwd) as ReaderSessionRow | undefined;
  }

  saveReaderSession(s: Omit<ReaderSessionRow, 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO document_sessions (message_id, agent_id, cwd, claude_session_id, flags_hash, created_at)
         VALUES (@message_id, @agent_id, @cwd, @claude_session_id, @flags_hash, @created_at)
         ON CONFLICT (message_id, agent_id, cwd) DO UPDATE SET
           claude_session_id = excluded.claude_session_id, flags_hash = excluded.flags_hash, created_at = excluded.created_at`,
      )
      .run({ ...s, created_at: Date.now() });
  }

  deleteReaderSession(messageId: string, agentId: string, cwd: string): void {
    this.db.prepare(`DELETE FROM document_sessions WHERE message_id = ? AND agent_id = ? AND cwd = ?`).run(messageId, agentId, cwd);
  }

  // ---- runs ----

  createRun(r: { kind: RunRow['kind']; status: string; thread_id?: string | null; parent_run_id?: string | null; meta?: unknown }): RunRow {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, parent_run_id, started_at, thread_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, r.kind, r.status, r.parent_run_id ?? null, Date.now(), r.thread_id ?? null, json(r.meta));
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'finished_at' | 'error' | 'meta'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE runs SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }

  // ---- routines ----

  getRoutineState(id: string): RoutineStateRow | undefined {
    return this.db.prepare(`SELECT * FROM routine_state WHERE routine_id = ?`).get(id) as RoutineStateRow | undefined;
  }

  saveRoutineState(s: RoutineStateRow): void {
    this.db
      .prepare(
        `INSERT INTO routine_state (routine_id, last_success_slot, last_attempt_at, last_error)
         VALUES (@routine_id, @last_success_slot, @last_attempt_at, @last_error)
         ON CONFLICT (routine_id) DO UPDATE SET last_success_slot = excluded.last_success_slot,
           last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`,
      )
      .run(s);
  }

  // ---- dirs ----

  touchDir(path: string): void {
    this.db
      .prepare(`INSERT INTO dirs_recent (path, used_at) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET used_at = excluded.used_at`)
      .run(path, Date.now());
  }

  recentDirs(): { path: string; used_at: number }[] {
    return this.db.prepare(`SELECT * FROM dirs_recent ORDER BY used_at DESC LIMIT 200`).all() as any;
  }

  channelDirs(): string[] {
    return (this.db.prepare(`SELECT DISTINCT dir FROM conversations WHERE dir IS NOT NULL`).all() as { dir: string }[]).map((r) => r.dir);
  }
}
