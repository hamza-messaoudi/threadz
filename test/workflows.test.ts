import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderStepPrompt } from '../server/core/workflows.ts';
import { agentFile, makeFakeApp, tmpDir, waitFor } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const WF = 'name: brief\ndescription: research then write\nsteps:\n  - agent: researcher\n    prompt: "Research this: {{input}}"\n  - agent: writer\n    prompt: "Turn the research above into a brief. Prev: {{prev}}"\n';
const wfTag = (text: string) => [{ kind: 'workflow', id: 'brief', start: text.indexOf('@brief'), end: text.indexOf('@brief') + 6 }];

describe('workflows', () => {
  it('renders only {{input}} and {{prev}}', () => {
    expect(renderStepPrompt('a {{input}} b {{ prev }} {{other}}', 'IN', 'PV')).toBe('a IN b PV {{other}}');
  });

  it('runs steps strictly in order; step 2 sees step 1 output in <thread_update>', async () => {
    const t = makeFakeApp({
      'agents/researcher.md': agentFile('researcher', 'FAKE_DELAY=150\nFAKE_REPLY=RESEARCH-NOTES'),
      'agents/writer.md': agentFile('writer', 'FAKE_REPLY=THE-BRIEF'),
      'workflows/brief.yaml': WF,
    });
    cleanup.push(() => t.ctx.close());
    const chat = (await t.call('POST', '/api/conversations', { kind: 'chat' })).body;
    const text = '@brief history of SQLite';
    const r = await t.post(chat.rootThreadId, text, wfTag(text));
    expect(r.workflowRunId).toBeTruthy();
    expect(await t.ctx.workflows.wait(r.workflowRunId)).toBe(true);

    const [c1, c2] = t.calls();
    expect(t.calls().length).toBe(2);
    expect(c1.stdin).toContain('<message from="workflow:brief">\nResearch this: history of SQLite\n</message>');
    expect(c2.time).toBeGreaterThanOrEqual(c1.time + 150);
    expect(c2.stdin).toMatch(/\[agent:researcher [^\]]+\] RESEARCH-NOTES/);
    expect(c2.stdin).toContain('Prev: RESEARCH-NOTES');

    const run = t.ctx.store.getRun(r.workflowRunId)!;
    expect(run.status).toBe('done');
    const thread = (await t.call('GET', `/api/threads/${chat.rootThreadId}`)).body;
    const kinds = thread.messages.map((m: any) => m.meta?.kind ?? m.authorId ?? m.authorKind);
    expect(kinds).toEqual(['user', 'workflow_card', 'workflow_step', 'researcher', 'workflow_step', 'writer']);
    expect(thread.runs[r.workflowRunId].meta.steps.map((s: any) => s.status)).toEqual(['done', 'done']);
  });

  it('a failing step 1 leaves step 2 unstarted; retry resumes at step 1', async () => {
    const flag = path.join(tmpDir(), 'fail');
    fs.writeFileSync(flag, '1');
    const t = makeFakeApp({
      'agents/researcher.md': agentFile('researcher', `FAKE_FAIL_IF_EXISTS=${flag}\nFAKE_REPLY=R`),
      'agents/writer.md': agentFile('writer', 'FAKE_REPLY=W'),
      'workflows/brief.yaml': WF,
    });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const text = '@brief topic';
    const r = await t.post(ch.rootThreadId, text, wfTag(text));
    expect(await t.ctx.workflows.wait(r.workflowRunId)).toBe(false);
    let run = t.ctx.store.getRun(r.workflowRunId)!;
    expect(run.status).toBe('error');
    expect(JSON.parse(run.meta!).steps.map((s: any) => s.status)).toEqual(['error', 'skipped']);
    expect(t.calls().length).toBe(1);

    fs.rmSync(flag);
    expect((await t.call('POST', `/api/runs/${r.workflowRunId}/retry`)).status).toBe(200);
    expect(await t.ctx.workflows.wait(r.workflowRunId)).toBe(true);
    const calls = t.calls();
    expect(calls.length).toBe(3);
    expect(calls[1].stdin).toContain('Research this: topic'); // retried step 1
    run = t.ctx.store.getRun(r.workflowRunId)!;
    expect(run.status).toBe('done');
  });

  it('cancel stops the current step and skips the rest', async () => {
    const t = makeFakeApp({ 'agents/researcher.md': agentFile('researcher', 'FAKE_HANG'), 'agents/writer.md': agentFile('writer'), 'workflows/brief.yaml': WF });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const text = '@brief topic';
    const r = await t.post(ch.rootThreadId, text, wfTag(text));
    await waitFor(() => t.calls().length === 1);
    await t.call('POST', `/api/runs/${r.workflowRunId}/cancel`);
    expect(await t.ctx.workflows.wait(r.workflowRunId)).toBe(false);
    const run = t.ctx.store.getRun(r.workflowRunId)!;
    expect(run.status).toBe('cancelled');
    expect(JSON.parse(run.meta!).steps.map((s: any) => s.status)).toEqual(['cancelled', 'skipped']);
    expect(t.calls().length).toBe(1);
  });

  it('rejects agents and a workflow tagged together', async () => {
    const t = makeFakeApp({ 'agents/researcher.md': agentFile('researcher'), 'agents/writer.md': agentFile('writer'), 'workflows/brief.yaml': WF });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const res = await t.call('POST', `/api/threads/${ch.rootThreadId}/messages`, { text: '@brief @writer x' });
    expect(res.status).toBe(400);
  });
});
