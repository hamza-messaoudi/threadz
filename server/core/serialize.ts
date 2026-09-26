import type { AppContext } from '../app.ts';
import type { ConversationRow, MessageRow, RunRow, Store } from '../db/queries.ts';

const parse = (s: string | null) => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export function serializeMessage(m: MessageRow) {
  // Thinking shares the tool_events column with tool calls (see TurnRunner).
  const steps: any[] = parse(m.tool_events) ?? [];
  return {
    id: m.id,
    threadId: m.thread_id,
    authorKind: m.author_kind,
    authorId: m.author_id,
    content: m.content_md,
    toolEvents: steps.filter((s) => s.kind !== 'thinking'),
    thinking: steps.filter((s) => s.kind === 'thinking'),
    status: m.status,
    error: m.error,
    usage: parse(m.usage),
    runId: m.run_id,
    doneSeq: m.done_seq,
    createdAt: m.created_at,
    cwd: m.cwd,
    sessionId: m.session_id,
    markers: parse(m.markers) ?? [],
    mentions: parse(m.mentions),
    meta: parse(m.meta),
  };
}
export type ApiMessage = ReturnType<typeof serializeMessage>;

export function serializeConversation(c: ConversationRow & { root_thread_id?: string; last_activity?: number }) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    dir: c.dir,
    yolo: !!c.yolo,
    routineId: c.routine_id,
    archived: !!c.archived,
    createdAt: c.created_at,
    rootThreadId: c.root_thread_id,
    lastActivity: c.last_activity,
  };
}

export function serializeRun(r: RunRow) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
    threadId: r.thread_id,
    meta: parse(r.meta),
  };
}

export function serializeChildThread(t: ReturnType<Store['childThreadSummaries']>[number]) {
  return {
    id: t.id,
    parentMessageId: t.parent_message_id,
    blockIndex: t.block_index,
    blockEnd: t.block_end,
    replyCount: t.reply_count,
    lastActivity: t.last_activity ?? t.created_at,
    channel: t.channel_id ? { id: t.channel_id, name: t.channel_name! } : null,
    /** An edit of the document changed the passage, or removed it (the thread is detached: blockIndex < 0). */
    anchor: t.anchor,
    anchorVersion: t.anchor_version,
    quote: t.quote ? t.quote.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').slice(0, 100) : null,
  };
}

/** Keeps the parent's thread badge (reply count, last activity, passage) live, also after the thread became a channel. */
export function publishChildSummary(ctx: Pick<AppContext, 'store' | 'hub'>, threadId: string): void {
  const t = ctx.store.getThread(threadId);
  const parentId = t?.parent_thread_id ?? t?.origin_thread_id;
  if (!parentId) return;
  const sum = ctx.store.childThreadSummaries(parentId).find((x) => x.id === t!.id);
  if (!sum) return;
  ctx.hub.thread(parentId, 'thread.created', serializeChildThread(sum));
}
