import type { MessageRow } from '../db/queries.ts';
import { formatLine } from './delta.ts';

export const SEED_MAX_MESSAGES = 60;
export const SEED_MAX_CHARS = 40_000;

/**
 * Picks the transcript for a brand-new session: newest messages kept, oldest dropped, within both
 * limits. Input and output are oldest-first. A single message longer than the budget is cut.
 */
export function truncateSeed<T extends { line: string }>(items: T[], maxMessages = SEED_MAX_MESSAGES, maxChars = SEED_MAX_CHARS): T[] {
  const out: T[] = [];
  let chars = 0;
  for (let i = items.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const item = items[i];
    const cost = item.line.length + 1;
    if (chars + cost > maxChars) {
      if (out.length === 0) out.push({ ...item, line: item.line.slice(0, maxChars - 20) + ' …[truncated]' });
      break;
    }
    chars += cost;
    out.push(item);
  }
  return out.reverse();
}

export function renderSeed(messages: MessageRow[], selfAgent: string, now?: number): { text: string; included: MessageRow[] } {
  const items = messages
    .filter((m) => m.status === 'done' && m.author_kind !== 'system' && m.content_md.trim())
    .map((m) => ({ m, line: formatLine(m, selfAgent, now) }));
  const kept = truncateSeed(items);
  if (!kept.length) return { text: '', included: [] };
  const dropped = items.length - kept.length;
  const head = dropped
    ? `You are joining an ongoing conversation. The ${dropped} oldest messages are omitted; the rest follow, oldest first. Tool calls are not shown.`
    : 'You are joining an ongoing conversation. Earlier messages follow, oldest first. Tool calls are not shown.';
  return {
    text: `<conversation_history>\n${head}\n${kept.map((k) => k.line).join('\n')}\n</conversation_history>`,
    included: kept.map((k) => k.m),
  };
}
