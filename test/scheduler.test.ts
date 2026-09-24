import { afterEach, describe, expect, it } from 'vitest';
import { isDue, lastSlot, nextSlot } from '../server/scheduler/due.ts';
import { agentFile, makeFakeApp, waitFor } from './helpers.ts';

// vitest.config.ts sets TZ=Europe/Madrid.
const T = (s: string) => new Date(s).getTime(); // local time strings
const iso = (n: number) => {
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('lastSlot / isDue', () => {
  const daily = { daily: '07:00' };
  it('runs in Europe/Madrid', () => expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Madrid'));

  it('daily before and after 07:00', () => {
    expect(iso(lastSlot(daily, T('2026-09-23T06:59:00')))).toBe('2026-09-22 07:00');
    expect(iso(lastSlot(daily, T('2026-09-23T07:00:00')))).toBe('2026-09-23 07:00');
    expect(iso(lastSlot(daily, T('2026-09-23T15:00:00')))).toBe('2026-09-23 07:00');
    expect(iso(nextSlot(daily, T('2026-09-23T07:00:00')))).toBe('2026-09-24 07:00');
  });

  it('a three-day gap yields one due slot (the latest)', () => {
    const state = { last_success_slot: T('2026-09-20T07:00:00') };
    const now = T('2026-09-23T09:00:00');
    expect(isDue(state, daily, now)).toBe(true);
    expect(iso(lastSlot(daily, now))).toBe('2026-09-23 07:00');
    expect(isDue({ last_success_slot: lastSlot(daily, now) }, daily, now)).toBe(false);
  });

  it('a routine added at 15:00 is due immediately for today', () => {
    expect(isDue(undefined, daily, T('2026-09-23T15:00:00'))).toBe(true);
    expect(isDue({ last_success_slot: null }, daily, T('2026-09-23T15:00:00'))).toBe(true);
  });

  it('weekly on and off the weekday', () => {
    const w = { weekly: 'mon 07:00' };
    // 2026-09-21 is a Monday.
    expect(iso(lastSlot(w, T('2026-09-21T06:00:00')))).toBe('2026-09-14 07:00');
    expect(iso(lastSlot(w, T('2026-09-21T07:30:00')))).toBe('2026-09-21 07:00');
    expect(iso(lastSlot(w, T('2026-09-23T10:00:00')))).toBe('2026-09-21 07:00');
    expect(iso(lastSlot(w, T('2026-09-20T23:59:00')))).toBe('2026-09-14 07:00');
    expect(iso(nextSlot(w, T('2026-09-21T07:30:00')))).toBe('2026-09-28 07:00');
  });

  it('handles the March DST change (last Sunday of March, 02:00 -> 03:00)', () => {
    // 2026-03-29: clocks jump forward.
    expect(iso(lastSlot(daily, T('2026-03-29T08:00:00')))).toBe('2026-03-29 07:00');
    expect(iso(lastSlot(daily, T('2026-03-29T06:00:00')))).toBe('2026-03-28 07:00');
    expect(lastSlot(daily, T('2026-03-29T08:00:00')) - lastSlot(daily, T('2026-03-28T08:00:00'))).toBe(23 * 3600_000);
    expect(iso(lastSlot({ weekly: 'sun 07:00' }, T('2026-03-30T10:00:00')))).toBe('2026-03-29 07:00');
    expect(iso(lastSlot({ daily: '02:30' }, T('2026-03-29T12:00:00')))).toMatch(/^2026-03-29 0[23]:30$/); // nonexistent local time
  });

  it('handles the October DST change (last Sunday of October, 03:00 -> 02:00)', () => {
    // 2026-10-25: clocks go back.
    expect(iso(lastSlot(daily, T('2026-10-25T08:00:00')))).toBe('2026-10-25 07:00');
    expect(lastSlot(daily, T('2026-10-25T08:00:00')) - lastSlot(daily, T('2026-10-24T08:00:00'))).toBe(25 * 3600_000);
    expect(iso(lastSlot({ weekly: 'sun 07:00' }, T('2026-10-26T06:00:00')))).toBe('2026-10-25 07:00');
    expect(isDue({ last_success_slot: T('2026-10-24T07:00:00') }, daily, T('2026-10-25T07:30:00'))).toBe(true);
  });
});

describe('scheduler', () => {
  const routine = (name: string, target: string, extra = '') => `name: ${name}\nschedule: { daily: "07:00" }\ntarget: ${target}\nprompt: "do ${name}"\n${extra}`;

  it('runs two due routines sequentially, never in parallel', async () => {
    const t = makeFakeApp({
      'agents/a.md': agentFile('a', 'FAKE_DELAY=200\nFAKE_REPLY=report'),
      'routines/one.yaml': routine('one', 'agent:a'),
      'routines/two.yaml': routine('two', 'agent:a'),
    });
    cleanup.push(() => t.ctx.close());
    t.ctx.scheduler.check();
    await waitFor(() => t.calls().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.calls().length).toBe(1); // second waits for the first
    await t.ctx.scheduler.whenIdle();
    const calls = t.calls();
    expect(calls.length).toBe(2);
    expect(calls[1].time).toBeGreaterThanOrEqual(calls[0].time + 200);
    expect(calls[0].stdin).toBe('<message from="routine:one">\ndo one\n</message>');
    expect(calls[0].argv).not.toContain('--resume');
    for (const name of ['one', 'two']) {
      const st = t.ctx.store.getRoutineState(name)!;
      expect(st.last_error).toBeNull();
      expect(st.last_success_slot).toBeGreaterThan(0);
      const conv = t.ctx.store.getRoutineConversation(name)!;
      expect(conv.name).toBe(`routine-${name}`);
      const msgs = t.ctx.store.listMessages(t.ctx.store.rootThread(conv.id).id);
      expect(msgs.map((m) => m.author_kind)).toEqual(['system', 'agent']);
      expect(msgs[0].content_md).toMatch(/^Daily run · /);
    }
    // Already done for this slot: another check does nothing.
    t.ctx.scheduler.check();
    await t.ctx.scheduler.whenIdle();
    expect(t.calls().length).toBe(2);
  });

  it('a failure is not retried by the periodic check; Retry succeeds and records the slot', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a', 'FAKE_FAIL'), 'routines/one.yaml': routine('one', 'agent:a') });
    cleanup.push(() => t.ctx.close());
    t.ctx.scheduler.check();
    await t.ctx.scheduler.whenIdle();
    let st = t.ctx.store.getRoutineState('one')!;
    expect(st.last_error).toContain('fake failure');
    expect(st.last_success_slot).toBeNull();
    expect((await t.call('GET', '/api/routines')).body[0].status).toBe('error');

    t.ctx.scheduler.check();
    await t.ctx.scheduler.whenIdle();
    expect(t.calls().length).toBe(1);

    t.ctx.cfg.agents.a.body = 'FAKE_REPLY=fixed';
    expect((await t.call('POST', '/api/routines/one/run')).body.queued).toBe(true);
    await waitFor(() => t.calls().length === 2);
    await t.ctx.scheduler.whenIdle();
    st = t.ctx.store.getRoutineState('one')!;
    expect(st.last_error).toBeNull();
    expect(st.last_success_slot).toBeGreaterThan(0);
    expect((await t.call('GET', '/api/routines')).body[0].status).toBe('ok');
  });

  it('a new run starts a fresh session and does not replay the previous run', async () => {
    const t = makeFakeApp({ 'agents/a.md': agentFile('a', 'FAKE_REPLY=first-report'), 'routines/one.yaml': routine('one', 'agent:a') });
    cleanup.push(() => t.ctx.close());
    t.ctx.scheduler.enqueue('one');
    await t.ctx.scheduler.whenIdle();
    t.ctx.scheduler.enqueue('one');
    await t.ctx.scheduler.whenIdle();
    const [c1, c2] = t.calls();
    expect(c2.argv).not.toContain('--resume');
    expect(c2.stdin).not.toContain('first-report');
    // Chatting afterwards continues today's session.
    const conv = t.ctx.store.getRoutineConversation('one')!;
    const r = await t.post(t.ctx.store.rootThread(conv.id).id, 'follow-up');
    await t.settled(r.agentMessageIds[0]);
    expect(t.calls()[2].argv.slice(-2)).toEqual(['--resume', c2.sessionId]);
    expect(c1.sessionId).not.toBe(c2.sessionId);
  });

  it('routines can target workflows', async () => {
    const t = makeFakeApp({
      'agents/a.md': agentFile('a', 'FAKE_REPLY=A-OUT'),
      'agents/b.md': agentFile('b', 'FAKE_REPLY=B-OUT'),
      'workflows/w.yaml': 'name: w\nsteps:\n  - agent: a\n    prompt: "{{input}}"\n  - agent: b\n    prompt: "summarise"\n',
      'routines/one.yaml': routine('one', 'workflow:w'),
    });
    cleanup.push(() => t.ctx.close());
    t.ctx.scheduler.enqueue('one');
    await t.ctx.scheduler.whenIdle();
    expect(t.calls().length).toBe(2);
    expect(t.calls()[0].stdin).toContain('do one');
    expect(t.ctx.store.getRoutineState('one')!.last_error).toBeNull();
  });
});
