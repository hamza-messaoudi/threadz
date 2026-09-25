import { afterEach, describe, expect, it } from 'vitest';
import { resolveMentions, stripWorkflowMentions } from '../server/context/mentions.ts';
import { renderSeed, truncateSeed } from '../server/context/seed.ts';
import type { MessageRow } from '../server/db/queries.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const names = { agents: new Set(['researcher', 'writer']), workflows: new Set(['brief']) };
const tag = (id: string, text: string, kind: 'agent' | 'workflow' = 'agent') => {
  const start = text.indexOf('@' + id);
  return { kind, id, start, end: start + id.length + 1 };
};

describe('mentions', () => {
  it('trusts structured mentions and ignores unknown names', () => {
    const text = '@researcher and @ghost look';
    expect(resolveMentions(text, [tag('researcher', text), { kind: 'agent', id: 'ghost', start: 16, end: 22 }], names).agents).toEqual(['researcher']);
  });
  it('falls back to regex parsing for plain text', () => {
    const r = resolveMentions('hey @writer, and @researcher. also me@example.com and @brief', undefined, names);
    expect(r.agents).toEqual(['writer', 'researcher']);
    expect(r.workflows).toEqual(['brief']);
  });
  it('collects referenced directories and keeps the last move', () => {
    const dirs = resolveMentions('x', [{ kind: 'dir', id: '/a', start: 0, end: 1 }, { kind: 'cd', id: '/b', start: 0, end: 1 }, { kind: 'dir', id: '/a', start: 0, end: 1 }, { kind: 'cd', id: '/c', start: 0, end: 1 }], names);
    expect(dirs.dirs).toEqual(['/a']);
    expect(dirs.move).toBe('/c'); // one move per message; the last one wins
  });
  it('strips workflow chips for {{input}}', () => {
    const text = '@brief the history of SQLite';
    expect(stripWorkflowMentions(text, [tag('brief', text, 'workflow')], 'brief')).toBe('the history of SQLite');
    expect(stripWorkflowMentions('please @brief this', undefined, 'brief')).toBe('please this');
  });
});

const row = (i: number, content: string, extra: Partial<MessageRow> = {}): MessageRow => ({
  id: String(i).padStart(4, '0'),
  thread_id: 't',
  author_kind: 'user',
  author_id: null,
  content_md: content,
  tool_events: null,
  status: 'done',
  error: null,
  usage: null,
  run_id: null,
  done_seq: i,
  created_at: Date.now(),
  cwd: null,
  session_id: null,
  markers: null,
  mentions: null,
  meta: null,
  ...extra,
});

describe('seed truncation', () => {
  it('keeps the newest messages within the message limit', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, line: `m${i}` }));
    const kept = truncateSeed(items, 60, 40000);
    expect(kept.length).toBe(60);
    expect(kept[0].id).toBe(40);
    expect(kept[59].id).toBe(99);
  });
  it('keeps the newest messages within the character limit', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, line: 'x'.repeat(999) })); // 1000 chars each with newline
    const kept = truncateSeed(items, 60, 3500);
    expect(kept.map((k) => k.id)).toEqual([7, 8, 9]);
  });
  it('cuts a single oversized newest message instead of dropping everything', () => {
    const kept = truncateSeed([{ id: 1, line: 'y'.repeat(50000) }], 60, 40000);
    expect(kept.length).toBe(1);
    expect(kept[0].line.length).toBeLessThanOrEqual(40000);
  });
  it('renders history without tool calls or system rows, respecting both real limits', () => {
    const msgs = [
      ...Array.from({ length: 70 }, (_, i) => row(i + 1, `message ${i + 1}`)),
      row(71, 'workflow prompt', { author_kind: 'system', author_id: 'brief' }),
    ];
    const seed = renderSeed(msgs, 'researcher');
    expect(seed.included.length).toBe(60);
    expect(seed.included[0].content_md).toBe('message 11');
    expect(seed.text).toContain('10 oldest messages are omitted');
    expect(seed.text).not.toContain('workflow prompt');
    const big = renderSeed(Array.from({ length: 30 }, (_, i) => row(i + 1, 'z'.repeat(3000))), 'researcher');
    expect(big.included.length).toBe(13);
    expect(big.text.length).toBeLessThan(41000);
  });
});

describe('multi-agent context', () => {
  it('parallel agents finishing in reverse order each see the other reply exactly once', async () => {
    const t = makeFakeApp({
      'agents/slow.md': agentFile('slow', 'FAKE_DELAY=500\nFAKE_REPLY=slow-answer'),
      'agents/fast.md': agentFile('fast', 'FAKE_DELAY=20\nFAKE_REPLY=fast-answer'),
    });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const both = (text: string) => [tag('slow', text), tag('fast', text)];

    const t1 = '@slow @fast compare approaches';
    const r1 = await t.post(ch.rootThreadId, t1, both(t1));
    const [slowId, fastId] = r1.agentMessageIds;
    // Ran concurrently: both processes were started before the slow one finished.
    const m1s = await t.settled(slowId);
    const m1f = t.message(fastId);
    expect(m1f.done_seq!).toBeLessThan(m1s.done_seq!); // reverse order
    expect(t.calls().length).toBe(2);
    expect(Math.abs(t.calls()[0].time - t.calls()[1].time)).toBeLessThan(400);

    const t2 = '@slow @fast now summarise';
    const r2 = await t.post(ch.rootThreadId, t2, both(t2));
    await Promise.all(r2.agentMessageIds.map((id: string) => t.settled(id)));
    const t3 = '@slow @fast one more';
    const r3 = await t.post(ch.rootThreadId, t3, both(t3));
    await Promise.all(r3.agentMessageIds.map((id: string) => t.settled(id)));

    const calls = t.calls();
    const bySession = (agentReply: string) => calls.filter((c) => c.argv.includes(`--append-system-prompt`) && c.argv[c.argv.indexOf('--append-system-prompt') + 1].includes(agentReply));
    const slowCalls = bySession('slow-answer');
    const fastCalls = bySession('fast-answer');
    expect(slowCalls.length).toBe(3);
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    const allSlowStdin = slowCalls.map((c) => c.stdin).join('\n');
    const allFastStdin = fastCalls.map((c) => c.stdin).join('\n');
    expect(count(allSlowStdin, 'fast-answer')).toBe(2); // turn-1 and turn-2 replies of fast, once each
    expect(count(allFastStdin, 'slow-answer')).toBe(2);
    // Turn 2: each sees exactly the other's turn-1 reply, and never its own.
    expect(count(slowCalls[1].stdin, 'fast-answer')).toBe(1);
    expect(count(fastCalls[1].stdin, 'slow-answer')).toBe(1);
    expect(slowCalls[1].stdin).not.toContain('slow-answer');
    expect(slowCalls[1].stdin).toContain('<thread_update>');
    // The user's own messages are sent once as <message>, never repeated in updates.
    expect(count(allSlowStdin, 'compare approaches')).toBe(1);
    expect(slowCalls[2].argv).toContain('--resume');
  });

  it('an untagged message with no previous agent is just posted', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r = await t.post(ch.rootThreadId, 'just a note');
    expect(r.agentMessageIds).toEqual([]);
  });

  it('a new chat is named from its first message', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a') });
    cleanup.push(() => t.ctx.close());
    const chat = (await t.call('POST', '/api/conversations', { kind: 'chat' })).body;
    await t.post(chat.rootThreadId, 'What is the difference between a mutex and a semaphore in practice?');
    expect(t.ctx.store.getConversation(chat.id)!.name).toBe('What is the difference between a mutex a');
  });

  it('seeds a new agent with the thread history', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a', 'FAKE_REPLY=from-a'), 'agents/b.md': agentFile('b') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r1 = await t.post(ch.rootThreadId, '@a hi', [tag('a', '@a hi')]);
    await t.settled(r1.agentMessageIds[0]);
    const r2 = await t.post(ch.rootThreadId, '@b join in', [tag('b', '@b join in')]);
    const m = await t.settled(r2.agentMessageIds[0]);
    const stdin = t.calls()[1].stdin;
    expect(stdin).toContain('<conversation_history>');
    expect(stdin).toContain('] from-a');
    expect(stdin).toContain('[you ');
    expect(stdin.trim().endsWith('<message from="you">\n@b join in\n</message>')).toBe(true);
    expect(JSON.parse(m.markers!)).toEqual(['new session']);
  });

  it('starts a new seeded session when the agent file changes', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a', 'v1') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r1 = await t.post(ch.rootThreadId, '@a hi', [tag('a', '@a hi')]);
    await t.settled(r1.agentMessageIds[0]);
    t.ctx.cfg.agents.a.body = 'v2';
    const r2 = await t.post(ch.rootThreadId, 'again');
    const m = await t.settled(r2.agentMessageIds[0]);
    expect(JSON.parse(m.markers!)).toEqual(['new session: agent config changed']);
    expect(t.calls()[1].argv).not.toContain('--resume');
  });
});
