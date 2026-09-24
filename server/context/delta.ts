import type { MessageRow } from '../db/queries.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** "09:14", or "Sep 22 09:14" when the message is not from today. */
export function stamp(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${time}`;
}

export function authorLabel(m: Pick<MessageRow, 'author_kind' | 'author_id'>, selfAgent?: string): string {
  if (m.author_kind === 'user') return 'you';
  if (m.author_kind === 'agent') return m.author_id === selfAgent ? `agent:${m.author_id} (you, earlier)` : `agent:${m.author_id}`;
  return `system:${m.author_id ?? 'app'}`;
}

export function formatLine(m: MessageRow, selfAgent?: string, now?: number): string {
  return `[${authorLabel(m, selfAgent)} ${stamp(m.created_at, now)}] ${m.content_md.trim()}`;
}

/** Messages the agent should see: other authors' final text; never system rows or its own replies. */
export function visibleTo(m: MessageRow, agentId: string): boolean {
  if (m.status !== 'done' || m.done_seq === null) return false;
  if (m.author_kind === 'system') return false;
  if (m.author_kind === 'agent' && m.author_id === agentId) return false;
  return m.content_md.trim().length > 0;
}

/**
 * The unseen part of a thread: done messages with done_seq above the cursor, not by this agent,
 * in done order. `excludeIds` removes the triggering message (it is sent separately).
 */
export function selectDelta(messages: MessageRow[], agentId: string, lastSeenSeq: number, excludeIds: string[] = []): MessageRow[] {
  return messages
    .filter((m) => (m.done_seq ?? 0) > lastSeenSeq && !excludeIds.includes(m.id) && visibleTo(m, agentId))
    .sort((a, b) => a.done_seq! - b.done_seq!);
}

export function renderUpdate(messages: MessageRow[], tag = 'thread_update', now?: number): string {
  if (!messages.length) return '';
  return `<${tag}>\n${messages.map((m) => formatLine(m, undefined, now)).join('\n')}\n</${tag}>`;
}

export function renderMessage(from: string, text: string): string {
  return `<message from="${from}">\n${text.trim()}\n</message>`;
}

/** Highest done_seq in a list, or `floor`. */
export function maxSeq(messages: Pick<MessageRow, 'done_seq'>[], floor = 0): number {
  return messages.reduce((a, m) => Math.max(a, m.done_seq ?? 0), floor);
}
