import type { AppContext, WorkflowService } from '../app.ts';
import { stripWorkflowMentions } from '../context/mentions.ts';
import type { MessageRow, ThreadRow } from '../db/queries.ts';
import { HttpError } from './dispatch.ts';
import { serializeMessage, serializeRun } from './serialize.ts';

export interface WorkflowStepState {
  agent: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped';
  messageId?: string;
}

export interface WorkflowRunMeta {
  workflow: string;
  cwd: string;
  input: string;
  step: number; // index of the current / failed step
  steps: WorkflowStepState[];
  cardMessageId: string;
  prev: string;
}

/** `{{input}}` and `{{prev}}` only; nothing else is a template. */
export function renderStepPrompt(template: string, input: string, prev: string): string {
  return template.replace(/\{\{\s*input\s*\}\}/g, input).replace(/\{\{\s*prev\s*\}\}/g, prev);
}

/** A workflow is scripted tagging: each step is a normal agent turn in the thread. */
export class WorkflowEngine implements WorkflowService {
  private cancelled = new Set<string>();
  private running = new Map<string, Promise<boolean>>();

  constructor(private readonly ctx: AppContext) {}

  start(opts: { workflow: string; thread: ThreadRow; trigger: MessageRow | null; cwd: string; mentions: unknown; input?: string }) {
    const { store, hub } = this.ctx;
    const wf = this.ctx.cfg.workflows[opts.workflow];
    if (!wf) throw new HttpError(400, `unknown workflow "${opts.workflow}"`);
    const input = opts.input ?? stripWorkflowMentions(opts.trigger?.content_md ?? '', opts.mentions, wf.name);
    const card = store.insertMessage({
      thread_id: opts.thread.id,
      author_kind: 'system',
      author_id: wf.name,
      content_md: wf.name,
      status: 'done',
      meta: { kind: 'workflow_card' },
    });
    const meta: WorkflowRunMeta = {
      workflow: wf.name,
      cwd: opts.cwd,
      input,
      step: 0,
      steps: wf.steps.map((s) => ({ agent: s.agent, status: 'pending' })),
      cardMessageId: card.id,
      prev: '',
    };
    const run = store.createRun({ kind: 'workflow', status: 'running', thread_id: opts.thread.id, meta });
    store.updateMessage(card.id, { run_id: run.id });
    hub.thread(opts.thread.id, 'run.updated', serializeRun(run));
    hub.thread(opts.thread.id, 'message.created', serializeMessage(store.getMessage(card.id)!));
    this.launch(run.id, 0);
    return run;
  }

  /** Resolves true when the run finished successfully. */
  wait(runId: string): Promise<boolean> {
    return this.running.get(runId) ?? Promise.resolve(this.ctx.store.getRun(runId)?.status === 'done');
  }

  retry(runId: string): void {
    const run = this.ctx.store.getRun(runId);
    if (!run || run.kind !== 'workflow') throw new HttpError(404, 'run not found');
    if (this.running.has(runId)) throw new HttpError(409, 'run is still going');
    if (run.status === 'done') throw new HttpError(400, 'run already finished');
    const meta = JSON.parse(run.meta!) as WorkflowRunMeta;
    this.launch(runId, meta.step);
  }

  cancel(runId: string): void {
    const run = this.ctx.store.getRun(runId);
    if (!run) throw new HttpError(404, 'run not found');
    this.cancelled.add(runId);
    const meta = JSON.parse(run.meta!) as WorkflowRunMeta;
    const current = meta.steps[meta.step]?.messageId;
    if (current) this.ctx.runner.cancel(current);
  }

  private launch(runId: string, fromStep: number): void {
    this.cancelled.delete(runId);
    const p = this.execute(runId, fromStep).finally(() => this.running.delete(runId));
    this.running.set(runId, p);
  }

  private save(runId: string, patch: { status?: string; error?: string | null; finished_at?: number | null }, meta: WorkflowRunMeta) {
    const { store, hub } = this.ctx;
    store.updateRun(runId, { ...patch, meta: JSON.stringify(meta) });
    const run = store.getRun(runId)!;
    hub.thread(run.thread_id!, 'run.updated', serializeRun(run));
  }

  private async execute(runId: string, fromStep: number): Promise<boolean> {
    const { store, hub, cfg } = this.ctx;
    const run = store.getRun(runId)!;
    const meta = JSON.parse(run.meta!) as WorkflowRunMeta;
    const threadId = run.thread_id!;
    const wf = cfg.workflows[meta.workflow];
    if (!wf) {
      this.save(runId, { status: 'error', error: `workflow "${meta.workflow}" no longer exists`, finished_at: Date.now() }, meta);
      return false;
    }
    for (let i = fromStep; i < meta.steps.length; i++) meta.steps[i] = { agent: meta.steps[i].agent, status: 'pending' };
    this.save(runId, { status: 'running', error: null, finished_at: null }, meta);

    for (let i = fromStep; i < wf.steps.length; i++) {
      meta.step = i;
      if (this.cancelled.has(runId)) return this.stop(runId, meta, i, 'cancelled');
      const step = wf.steps[i];
      const prompt = renderStepPrompt(step.prompt, meta.input, meta.prev);
      const stepMsg = store.insertMessage({
        thread_id: threadId,
        author_kind: 'system',
        author_id: wf.name,
        content_md: prompt,
        status: 'done',
        run_id: runId,
        meta: { kind: 'workflow_step', step: i + 1, total: wf.steps.length, agent: step.agent },
      });
      hub.thread(threadId, 'message.created', serializeMessage(stepMsg));
      const turn = this.ctx.runner.start({
        threadId,
        agentName: step.agent,
        cwd: meta.cwd,
        trigger: { messageId: stepMsg.id, seq: stepMsg.done_seq!, text: prompt, from: `workflow:${wf.name}` },
        runId,
      });
      meta.steps[i] = { agent: step.agent, status: 'running', messageId: turn.messageId };
      this.save(runId, {}, meta);
      const outcome = await turn.done;
      if (outcome.status !== 'done') {
        const cancelled = outcome.status === 'cancelled' || this.cancelled.has(runId);
        return this.stop(runId, meta, i, cancelled ? 'cancelled' : 'error', outcome.error ?? 'step failed');
      }
      meta.steps[i].status = 'done';
      meta.prev = outcome.text;
      this.save(runId, {}, meta);
    }
    meta.step = wf.steps.length;
    this.save(runId, { status: 'done', finished_at: Date.now() }, meta);
    return true;
  }

  private stop(runId: string, meta: WorkflowRunMeta, at: number, status: 'error' | 'cancelled', error?: string): false {
    meta.step = at;
    meta.steps[at].status = status;
    for (let j = at + 1; j < meta.steps.length; j++) meta.steps[j].status = 'skipped';
    this.save(runId, { status, error: status === 'error' ? `step ${at + 1} (@${meta.steps[at].agent}) failed: ${error}` : 'cancelled', finished_at: Date.now() }, meta);
    this.cancelled.delete(runId);
    return false;
  }
}
