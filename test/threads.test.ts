import { afterEach, describe, expect, it } from 'vitest';
import { blocksOf } from '../server/context/blocks.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const REPLY = 'First paragraph about caches.\\n\\nSecond paragraph about **indexes**.\\n\\n- item one\\n- item two';

async function setup() {
  const t = makeFakeApp({ 'agents/r.md': agentFile('r', `FAKE_REPLY=${REPLY}`), 'agents/w.md': agentFile('w', 'FAKE_REPLY=writer here') });
  cleanup.push(() => t.ctx.close());
  const ch = await t.channel();
  const r = await t.post(ch.rootThreadId, '@r explain', [{ kind: 'agent', id: 'r', start: 0, end: 2 }]);
  const m = await t.settled(r.agentMessageIds[0]);
  return { t, ch, m };
}

describe('blocks', () => {
  it('splits top-level markdown blocks and skips blank lines', async () => {
    expect(await blocksOf('a\n\n\n\nb\n\n```js\nx\n\ny\n```\n\n- 1\n- 2')).toEqual(['a', 'b', '```js\nx\n\ny\n```', '- 1\n- 2']);
  });

  it('keeps a whole figure, props included, as one block', async () => {
    const md = 'Intro\n\n::graph-meter{title="Coverage" value=0.86}\n::\n\n::graph-table\n---\nheaders: [A, B]\nrows:\n  - [1, 2]\n---\n::';
    const blocks = await blocksOf(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toBe('::graph-meter{title="Coverage" value=0.86}\n::');
    expect(blocks[2]).toContain('rows:');
  });
});

describe('paragraph threads', () => {
  it('a second POST for the same block returns the same thread', async () => {
    const { t, m } = await setup();
    const a = await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 });
    const b = await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(t.ctx.store.getThread(a.body.id)!.block_text).toBe('Second paragraph about **indexes**.');
    expect((await t.call('POST', '/api/threads', { message_id: m.id, block_index: 9 })).status).toBe(400);
    // No nesting: a thread message cannot start another thread.
  });

  it('first thread turn forks the parent session; the main timeline keeps resuming the parent', async () => {
    const { t, ch, m } = await setup();
    const parentSession = m.session_id!;
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 })).body;

    // Untagged: defaults to the source message's agent.
    const r1 = await t.post(th.id, 'why indexes?');
    const tm = await t.settled(r1.agentMessageIds[0]);
    expect(tm.author_id).toBe('r');
    const fork = t.calls()[1];
    expect(fork.argv.slice(-3)).toEqual(['--resume', parentSession, '--fork-session']);
    expect(fork.stdin).toContain('<thread_context>');
    expect(fork.stdin).toContain('> Second paragraph about **indexes**.');
    expect(tm.session_id).not.toBe(parentSession);
    expect(JSON.parse(tm.markers!)).toEqual(['thread session forked from the main conversation']);

    // Second thread turn resumes the forked session.
    const r2 = await t.post(th.id, 'more');
    const tm2 = await t.settled(r2.agentMessageIds[0]);
    expect(t.calls()[2].argv.slice(-2)).toEqual(['--resume', tm.session_id]);
    expect(tm2.session_id).toBe(tm.session_id);

    // Main timeline still resumes the parent, and never sees thread messages.
    const r3 = await t.post(ch.rootThreadId, 'back in main');
    await t.settled(r3.agentMessageIds[0]);
    const main = t.calls()[3];
    expect(main.argv.slice(-2)).toEqual(['--resume', parentSession]);
    expect(main.stdin).not.toContain('why indexes');
    expect(t.ctx.store.getSession(ch.rootThreadId, 'r', m.cwd!)!.claude_session_id).toBe(parentSession);
    const mainMsgs = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body;
    expect(mainMsgs.messages.map((x: any) => x.content)).not.toContain('why indexes?');
    expect(mainMsgs.childThreads[0].replyCount).toBe(4);
  });

  it('an agent without a parent session gets a seeded session with the parent transcript', async () => {
    const { t, m } = await setup();
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 0 })).body;
    const r = await t.post(th.id, '@w rewrite this', [{ kind: 'agent', id: 'w', start: 0, end: 2 }]);
    await t.settled(r.agentMessageIds[0]);
    const call = t.calls()[1];
    expect(call.argv).not.toContain('--resume');
    expect(call.stdin).toContain('<conversation_history>');
    expect(call.stdin).toContain('First paragraph about caches.');
    expect(call.stdin).toContain('<thread_context>');
  });

  it('refuses threads on unfinished messages', async () => {
    const t = makeFakeApp({ 'agents/slow.md': agentFile('slow', 'FAKE_HANG') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r = await t.post(ch.rootThreadId, '@slow x', [{ kind: 'agent', id: 'slow', start: 0, end: 5 }]);
    expect((await t.call('POST', '/api/threads', { message_id: r.agentMessageIds[0], block_index: 0 })).status).toBe(400);
    t.ctx.runner.cancelAll();
    await t.settled(r.agentMessageIds[0]);
  });
});
