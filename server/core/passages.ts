import type { AppContext } from '../app.ts';
import { formatLine, maxSeq, visibleTo } from '../context/delta.ts';
import type { MessageRow, SessionRow, ThreadRow } from '../db/queries.ts';
import { renderThreadContext } from '../runner/turn.ts';
import { HttpError } from './dispatch.ts';

export interface OpenedPassage {
  thread: ThreadRow;
  created: boolean;
  /** Threads folded into `thread` (now deleted). */
  absorbed: string[];
  /** The thread's passage changed (it grew over the new pick). */
  widened: boolean;
}

/**
 * The thread for blocks start..end of a message. A block belongs to at most one thread: a pick that
 * touches existing threads grows into one thread covering all of them, never a thread inside a thread.
 */
export function openPassage(ctx: AppContext, msg: MessageRow, start: number, end: number, blocks: string[]): OpenedPassage {
  const { store } = ctx;
  const all = store.threadsOnMessage(msg.id);
  // Grow the range until no thread sticks out of it (older data can hold overlapping threads).
  let lo = start;
  let hi = end;
  let hit: ThreadRow[] = [];
  for (let grew = true; grew; ) {
    hit = all.filter((t) => t.block_index! <= hi && lo <= t.block_end!);
    const nlo = Math.min(lo, ...hit.map((t) => t.block_index!));
    const nhi = Math.max(hi, ...hit.map((t) => t.block_end!));
    grew = nlo !== lo || nhi !== hi;
    lo = nlo;
    hi = nhi;
  }
  if (!hit.length) {
    const { thread, created } = store.upsertParagraphThread(msg, start, blocks.slice(start, end + 1).join('\n\n'), end);
    return { thread, created, absorbed: [], widened: false };
  }
  const channel = hit.find((t) => t.origin_thread_id);
  if (channel) {
    // A channel cannot fold into a side thread. Picking inside it just opens it, like a click.
    if (hit.length === 1 && start >= channel.block_index! && end <= channel.block_end!) return { thread: channel, created: false, absorbed: [], widened: false };
    const name = store.getConversation(channel.conversation_id)?.name ?? 'a channel';
    throw new HttpError(409, `Part of this passage became #${name}, so it cannot join another thread.`);
  }
  // Inside one thread already: open it as it is.
  if (hit.length === 1 && hit[0].block_index === lo && hit[0].block_end === hi) return { thread: hit[0], created: false, absorbed: [], widened: false };
  const busy = hit.find((t) => store.threadBusy(t.id));
  if (busy) throw new HttpError(409, 'A reply is still being written in a thread on this passage. Try again when it is done.');

  // The thread with the most replies stays: its agents keep their sessions, so the least history has to be re-sent.
  const replies = new Map(hit.map((t) => [t.id, store.listMessages(t.id).filter((m) => m.author_kind !== 'system')] as const));
  const into = [...hit].sort((a, b) => replies.get(b.id)!.length - replies.get(a.id)!.length || b.created_at - a.created_at)[0];
  const absorbed = hit.filter((t) => t !== into);
  const text = blocks.slice(lo, hi + 1).join('\n\n');
  const widenedThread: ThreadRow = { ...into, block_index: lo, block_end: hi, block_text: text };

  // One Claude session per (agent, cwd): the kept thread's own, else the most recent one of a merged thread.
  // It learns what it missed as appended text on its next turn, so its prompt cache still hits.
  const done = new Map(hit.map((t) => [t.id, store.doneMessages(t.id)] as const));
  const everything = hit.flatMap((t) => done.get(t.id)!);
  const cursor = maxSeq(everything);
  const source = store.getMessage(msg.id);
  const kept = new Map<string, SessionRow & { from: string }>();
  const others = absorbed.flatMap((t) => store.threadSessions(t.id)).sort((a, b) => b.updated_at - a.updated_at);
  for (const s of [...store.threadSessions(into.id), ...others]) {
    const key = `${s.agent_id}\0${s.cwd}`;
    if (!kept.has(key)) kept.set(key, { ...s, from: s.thread_id });
  }
  const sessions = [...kept.values()].map(({ from, ...s }) => {
    const missed = hit.flatMap((t) =>
      done.get(t.id)!.filter((m) => (t.id === from ? (m.done_seq ?? 0) > s.last_seen_seq && visibleTo(m, s.agent_id) : shown(m))),
    );
    const pending = join(s.pending ?? '', renderWidened(widenedThread, source, absorbed.length), renderMerged(missed.sort(byId), s.agent_id));
    return { ...s, last_seen_seq: Math.max(s.last_seen_seq, cursor), pending, updated_at: Date.now() };
  });
  store.mergeThreads(
    into.id,
    absorbed.map((t) => t.id),
    { start: lo, end: hi, text },
    sessions,
  );
  return { thread: store.getThread(into.id)!, created: false, absorbed: absorbed.map((t) => t.id), widened: true };
}

/** Clears a side thread's replies and sessions; its next turn forks the main conversation again, a cache hit. */
export function resetThread(ctx: AppContext, thread: ThreadRow, drop: boolean): void {
  if (!thread.parent_thread_id) throw new HttpError(400, 'only a side thread can be reset');
  if (ctx.store.threadBusy(thread.id)) throw new HttpError(409, 'A reply is still being written. Stop it first.');
  ctx.store.clearThread(thread.id, drop);
}

/** A message from another thread: the session never saw it, its own agent's replies included. */
function shown(m: MessageRow): boolean {
  return m.status === 'done' && m.author_kind !== 'system' && m.content_md.trim().length > 0;
}

const byId = (a: MessageRow, b: MessageRow) => (a.id < b.id ? -1 : 1);

function renderWidened(thread: ThreadRow, source: MessageRow | undefined, absorbed: number): string {
  const context = renderThreadContext(thread, source).replace('<thread_context>', '').replace('</thread_context>', '').trim();
  const what = absorbed
    ? `The user merged ${absorbed === 1 ? 'another side thread' : `${absorbed} other side threads`} into this one, so it now covers a wider passage.`
    : 'The user widened the passage this side thread is about.';
  return `<thread_context_update>\n${what}\n${context}\n</thread_context_update>`;
}

function renderMerged(messages: MessageRow[], self: string): string {
  if (!messages.length) return '';
  const lines = messages.map((m) => formatLine(m, self));
  return `<merged_thread_messages>\nMessages from the merged threads that you have not seen, oldest first. Tool calls are not shown.\n${lines.join('\n')}\n</merged_thread_messages>`;
}

function join(...parts: string[]): string {
  return parts.filter((p) => p && p.trim()).join('\n\n');
}
