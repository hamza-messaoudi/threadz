import type { Message, Run } from '../lib/api.ts';

export function WorkflowCard({ m }: { m: Message; run?: Run }) {
  return <div className="wf-card">{m.content}</div>;
}
