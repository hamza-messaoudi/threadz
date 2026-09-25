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

  it('a thread can quote a run of paragraphs, next to the single-paragraph threads inside it', async () => {
    const { t, ch, m } = await setup();
    const single = await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 });
    const range = await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1, block_end: 2 });
    expect(range.status).toBe(201);
    expect(range.body.id).not.toBe(single.body.id);
    expect((await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1, block_end: 2 })).body.id).toBe(range.body.id);
    expect(t.ctx.store.getThread(range.body.id)!.block_text).toBe('Second paragraph about **indexes**.\n\n- item one\n- item two');
    for (const bad of [{ block_index: 2, block_end: 1 }, { block_index: 1, block_end: 3 }, { block_index: 0, block_end: 1.5 }])
      expect((await t.call('POST', '/api/threads', { message_id: m.id, ...bad })).status).toBe(400);

    const info = (await t.call('GET', `/api/threads/${range.body.id}`)).body.thread;
    expect([info.blockIndex, info.blockEnd]).toEqual([1, 2]);
    const kids = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body.childThreads.map((c: any) => [c.blockIndex, c.blockEnd]);
    expect(kids).toEqual(expect.arrayContaining([[1, 1], [1, 2]]));

    const r = await t.post(range.body.id, 'compare these');
    await t.settled(r.agentMessageIds[0]);
    const stdin = t.calls()[1].stdin;
    expect(stdin).toContain('on these 2 consecutive passages');
    expect(stdin).toContain('> Second paragraph about **indexes**.\n> \n> - item one');
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

describe('thread → channel', () => {
  it('keeps the thread id, so the next turn resumes the same session with no reseed', async () => {
    const { t, ch, m } = await setup();
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 })).body;
    const r1 = await t.settled((await t.post(th.id, 'why indexes?')).agentMessageIds[0]);

    const res = await t.call('POST', `/api/threads/${th.id}/promote`, { name: 'indexes' });
    expect(res.status).toBe(201);
    const conv = res.body;
    expect(conv).toMatchObject({ kind: 'channel', name: 'indexes', rootThreadId: th.id, dir: null });

    // The channel is listed, its root is the old thread, and a note marks the switch.
    const list = (await t.call('GET', '/api/conversations')).body;
    expect(list.find((c: any) => c.id === conv.id).rootThreadId).toBe(th.id);
    const data = (await t.call('GET', `/api/threads/${th.id}`)).body;
    expect(data.thread.parentThreadId).toBeNull();
    expect(data.thread.blockText).toBe('Second paragraph about **indexes**.');
    expect(data.origin).toMatchObject({ conversationId: ch.id, conversationName: 'main', threadId: ch.rootThreadId });
    expect(data.messages.at(-1).meta).toMatchObject({ kind: 'promoted' });

    // The next turn resumes the thread's session: same id, only the new message in the prompt.
    const r2 = await t.settled((await t.post(th.id, 'go on')).agentMessageIds[0]);
    const call = t.calls().at(-1)!;
    expect(call.argv.slice(-2)).toEqual(['--resume', r1.session_id]);
    expect(call.stdin).not.toContain('<conversation_history>');
    expect(call.stdin).not.toContain('<thread_context>');
    expect(r2.session_id).toBe(r1.session_id);
    expect(r2.markers).toBeNull();

    // The source passage now links to the channel, and reopening it lands there.
    const kids = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body.childThreads;
    expect(kids).toEqual([expect.objectContaining({ id: th.id, replyCount: 4, channel: { id: conv.id, name: 'indexes' } })]);
    const again = await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 });
    expect(again.body).toMatchObject({ id: th.id, conversationId: conv.id, created: false });

    // The channel can have side threads of its own.
    const inner = await t.call('POST', '/api/threads', { message_id: r2.id, block_index: 0 });
    expect(inner.status).toBe(201);
    expect(inner.body.conversationId).toBe(conv.id);
  });

  it('an agent new to the channel forks the session of the discussion it grew out of', async () => {
    const { t, m } = await setup();
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 })).body;
    await t.call('POST', `/api/threads/${th.id}/promote`, { name: 'indexes' });
    const r = await t.settled((await t.post(th.id, 'why indexes?')).agentMessageIds[0]);
    const call = t.calls().at(-1)!;
    expect(call.argv.slice(-3)).toEqual(['--resume', m.session_id, '--fork-session']);
    expect(call.stdin).toContain('This channel grew out of a side thread');
    expect(JSON.parse(r.markers!)).toEqual(['session forked from the conversation this channel grew out of']);
  });

  it('refuses root threads and missing names', async () => {
    const { t, ch, m } = await setup();
    expect((await t.call('POST', `/api/threads/${ch.rootThreadId}/promote`, { name: 'x' })).status).toBe(400);
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 0 })).body;
    expect((await t.call('POST', `/api/threads/${th.id}/promote`, { name: ' ' })).status).toBe(400);
    expect((await t.call('POST', `/api/threads/${th.id}/promote`, { name: 'x', dir: '/not/known' })).status).toBe(400);
  });
});
