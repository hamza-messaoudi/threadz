import { afterEach, describe, expect, it } from 'vitest';
import { buildArgs } from '../server/runner/spawn.ts';
import { agentFile, makeFakeApp, waitFor } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('buildArgs', () => {
  const agent = { model: 'sonnet', systemPrompt: 'You are researcher.' };
  const mode = { settingsPath: '/data/gate-settings.json', partial: true };

  it('is deterministic', () => {
    expect(buildArgs(agent, {}, mode)).toEqual(buildArgs({ ...agent }, {}, { ...mode }));
    expect(JSON.stringify(buildArgs(agent, { resume: 'abc' }, mode))).toBe(JSON.stringify(buildArgs(agent, { resume: 'abc' }, mode)));
  });

  it('only --resume / --fork-session vary between turns', () => {
    const a = buildArgs(agent, {}, mode);
    const b = buildArgs(agent, { resume: 'abc' }, mode);
    const c = buildArgs(agent, { resume: 'abc', fork: true }, mode);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b.slice(a.length)).toEqual(['--resume', 'abc']);
    expect(c.slice(a.length)).toEqual(['--resume', 'abc', '--fork-session']);
  });
});

describe('runner with fake claude', () => {
  it('streams a reply, then resumes the same session with identical flags', async () => {
    const t = makeFakeApp({ 'agents/researcher.md': agentFile('researcher') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const deltas: string[] = [];
    cleanup.push(t.ctx.hub.subscribe(`thread:${ch.rootThreadId}`, (ev, d: any) => ev === 'message.delta' && deltas.push(d.text)));

    const r1 = await t.post(ch.rootThreadId, '@researcher hello there', [{ kind: 'agent', id: 'researcher', start: 0, end: 11 }]);
    const m1 = await t.settled(r1.agentMessageIds[0]);
    expect(m1.status).toBe('done');
    expect(m1.content_md).toBe('ack: @researcher hello there');
    expect(deltas.length).toBeGreaterThan(1);
    expect(m1.session_id).toMatch(/^fake-/);
    expect(JSON.parse(m1.markers!)).toEqual(['new session']);

    // Untagged follow-up goes to the last agent that replied.
    const r2 = await t.post(ch.rootThreadId, 'and again');
    const m2 = await t.settled(r2.agentMessageIds[0]);
    expect(m2.status).toBe('done');
    expect(m2.session_id).toBe(m1.session_id);
    expect(m2.markers).toBeNull();
    const usage = JSON.parse(m2.usage!);
    expect(usage.first_call.cache_read_input_tokens).toBe(20000);

    const [c1, c2] = t.calls();
    expect(c2.argv.slice(0, c1.argv.length)).toEqual(c1.argv);
    expect(c2.argv.slice(c1.argv.length)).toEqual(['--resume', m1.session_id]);
    expect(c1.env.AGENT_MODE).toBe('readonly');
    expect(c2.stdin).toBe('<message from="you">\nand again\n</message>');
  });

  it('cancels a running turn by killing its process group', async () => {
    const t = makeFakeApp({ 'agents/slow.md': agentFile('slow', 'FAKE_HANG') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r = await t.post(ch.rootThreadId, '@slow go', [{ kind: 'agent', id: 'slow', start: 0, end: 5 }]);
    const id = r.agentMessageIds[0];
    await waitFor(() => t.calls().length === 1);
    expect((await t.call('POST', `/api/messages/${id}/cancel`)).body.cancelled).toBe(true);
    const m = await t.settled(id);
    expect(m.status).toBe('cancelled');
  });

  it('reports claude errors with the stderr excerpt', async () => {
    const t = makeFakeApp({ 'agents/bad.md': agentFile('bad', 'FAKE_FAIL') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r = await t.post(ch.rootThreadId, '@bad go', [{ kind: 'agent', id: 'bad', start: 0, end: 4 }]);
    const m = await t.settled(r.agentMessageIds[0]);
    expect(m.status).toBe('error');
    expect(m.error).toContain('fake failure');
  });

  it('queues turns beyond maxConcurrent', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a', 'FAKE_DELAY=300'), 'agents/b.md': agentFile('b', 'FAKE_DELAY=300') }, { maxConcurrent: 1 });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r = await t.post(ch.rootThreadId, '@a @b go', [
      { kind: 'agent', id: 'a', start: 0, end: 2 },
      { kind: 'agent', id: 'b', start: 3, end: 5 },
    ]);
    await waitFor(() => t.calls().length === 1);
    const statuses = r.agentMessageIds.map((id: string) => t.message(id).status).sort();
    expect(statuses).toEqual(['queued', 'streaming']);
    await Promise.all(r.agentMessageIds.map((id: string) => t.settled(id)));
  });
});

describe('YOLO toggle', () => {
  it('changes only AGENT_MODE, never the flags', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const r1 = await t.post(ch.rootThreadId, '@a one', [{ kind: 'agent', id: 'a', start: 0, end: 2 }]);
    await t.settled(r1.agentMessageIds[0]);
    await t.call('PATCH', `/api/conversations/${ch.id}`, { yolo: true });
    const r2 = await t.post(ch.rootThreadId, 'two');
    await t.settled(r2.agentMessageIds[0]);
    const r3 = await t.post(ch.rootThreadId, 'three');
    await t.settled(r3.agentMessageIds[0]);
    const [c1, c2, c3] = t.calls();
    expect(c1.env.AGENT_MODE).toBe('readonly');
    expect(c2.env.AGENT_MODE).toBe('yolo');
    expect(c3.argv).toEqual(c2.argv);
    expect(c2.argv.slice(0, c1.argv.length)).toEqual(c1.argv);
    expect(c1.env.AGENT_CHAT_GATE_CONFIG).toMatch(/gate\.json$/);
    expect(JSON.parse(c1.env.AGENT_TOOLS)).toEqual([]);
  });
});
