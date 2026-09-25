import { Check, FlowArrow, Minus, X } from '@phosphor-icons/react';
import { api, type Message, type Run } from '../lib/api.ts';

interface StepState {
  agent: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped';
}

/** Compact progress card for a workflow run: "research-to-brief · step 1 of 2 · @researcher". */
export function WorkflowCard({ m, run }: { m: Message; run?: Run }) {
  if (!run) return <div className="wf-card muted">{m.content}</div>;
  const meta = run.meta ?? {};
  const steps: StepState[] = meta.steps ?? [];
  const total = steps.length;
  const current = Math.min(meta.step ?? 0, Math.max(total - 1, 0));
  const status = run.status;
  const label =
    status === 'done'
      ? `done · ${total} ${total === 1 ? 'step' : 'steps'}`
      : status === 'running'
        ? `step ${current + 1} of ${total} · @${steps[current]?.agent}`
        : status === 'cancelled'
          ? `cancelled at step ${current + 1} of ${total}`
          : `failed at step ${current + 1} of ${total}`;

  return (
    <div className="wf-card" id={`m-${m.id}`}>
      <div className="row">
        <strong className="wf-title"><FlowArrow size={14} aria-hidden /> {meta.workflow ?? m.content}</strong>
        <span className={status === 'error' ? 'error-text' : 'muted'}>{label}</span>
        <span className="spacer" />
        {status === 'running' && (
          <button className="btn small" onClick={() => api.post(`/api/runs/${run.id}/cancel`)}>
            Cancel
          </button>
        )}
        {(status === 'error' || status === 'cancelled') && (
          <button className="btn small" onClick={() => api.post(`/api/runs/${run.id}/retry`)}>
            Retry from step {current + 1}
          </button>
        )}
      </div>
      <div className="wf-steps">
        {steps.map((s, i) => (
          <span key={i} className={`wf-step ${s.status === 'done' ? 'done' : s.status === 'running' ? 'current' : s.status === 'error' ? 'failed' : ''}`}>
            {i + 1}. @{s.agent} {s.status === 'done' ? <Check size={11} weight="bold" aria-label="done" /> : s.status === 'running' ? '…' : s.status === 'error' ? <X size={11} weight="bold" aria-label="failed" /> : s.status === 'skipped' || s.status === 'cancelled' ? <Minus size={11} weight="bold" aria-label={s.status} /> : ''}
          </span>
        ))}
      </div>
      {status === 'error' && run.error && <div className="error-text">{run.error.split('\n')[0]}</div>}
    </div>
  );
}
