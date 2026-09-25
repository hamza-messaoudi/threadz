import { useLayoutEffect, useReducer, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Message, ThinkingEvent, ToolEvent } from '../lib/api.ts';
import { parseMessage } from '../markdown/parse.ts';
import { ICONS } from './icons.tsx';
import { Accordion } from './transitions.tsx';

/** One step of an agent's turn, shown between the text it wrote before and after it. */
export type Step = { kind: 'tool'; id: string; at: number; tool: ToolEvent } | { kind: 'thinking'; id: string; at: number; thinking: ThinkingEvent };

/** Tool calls and thinking in the order they happened. Older messages have no `at`: their tools lead. */
export function orderSteps(m: Message): Step[] {
  const steps: (Step & { seq: number })[] = [
    ...(m.thinking ?? []).map((t, i) => ({ kind: 'thinking' as const, id: t.id, at: t.at, seq: t.seq ?? i, thinking: t })),
    ...m.toolEvents.map((t, i) => ({ kind: 'tool' as const, id: t.id, at: t.at ?? 0, seq: t.seq ?? i, tool: t })),
  ];
  return steps.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

// `${messageId}:${at}` → how many blocks the message text had at that length. Text only grows, so it never goes stale.
const anchorCache = new Map<string, number>();

/**
 * For each step offset, the index of the first block written after it. `ready` once every offset is
 * measured; until then (and for an offset past the text so far) a step sits after the text.
 */
export function useAnchors(id: string, content: string, ats: number[]): { anchors: Map<number, number>; ready: boolean } {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const found = new Map<number, number>();
  const missing: number[] = [];
  for (const at of new Set(ats)) {
    if (at <= 0) found.set(at, 0);
    else if (at > content.length) continue;
    else {
      const hit = anchorCache.get(`${id}:${at}`);
      if (hit === undefined) missing.push(at);
      else found.set(at, hit);
    }
  }
  const key = missing.join(',');
  useLayoutEffect(() => {
    if (!missing.length) return;
    let live = true;
    Promise.all(
      missing.map((at) => parseMessage(content.slice(0, at)).then((p) => void anchorCache.set(`${id}:${at}`, p?.blocks.length ?? 0))),
    ).then(() => live && flushSync(bump));
    if (anchorCache.size > 5000) anchorCache.clear();
    return () => {
      live = false;
    };
    // `content` is read only for offsets in `key`, whose prefixes never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);
  return { anchors: found, ready: !missing.length };
}

export function StepRow({ step, live }: { step: Step; live: boolean }) {
  return step.kind === 'tool' ? <ToolRow t={step.tool} live={live} /> : <ThinkingRow t={step.thinking} live={live} />;
}

function ThinkingRow({ t, live }: { t: ThinkingEvent; live: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = firstLine(t.text);
  return (
    <Accordion
      open={open}
      className="turn-step"
      head={
        <button className="step-line" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!t.text.trim()}>
          <span className="step-icon">{ICONS.brain}</span>
          <span className={`step-name ${live ? 'step-live' : ''}`} data-text="Thinking">
            Thinking
          </span>
          {preview && <span className="step-arg prose">{preview}</span>}
        </button>
      }
    >
      <div className="step-detail step-thinking">{t.text.trim()}</div>
    </Accordion>
  );
}

function ToolRow({ t, live }: { t: ToolEvent; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = live && t.output_preview === undefined;
  const name = prettyTool(t.name);
  const arg = toolSummary(t).replace(/\s+/g, ' ');
  return (
    <Accordion
      open={open}
      className={`turn-step ${t.denied ? 'denied' : t.is_error ? 'err' : ''}`}
      head={
        <button
          className="step-line"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-tooltip={t.denied ? 'Blocked by the read-only gate' : undefined}
        >
          <span className="step-icon">{t.denied ? ICONS.lock : toolIcon(t.name)}</span>
          <span className={`step-name ${running ? 'step-live' : ''}`} data-text={name}>
            {name}
          </span>
          {arg && <span className="step-arg">{arg}</span>}
        </button>
      }
    >
      <div className="step-detail tool-detail">
        <strong>Input</strong>
        <pre>{JSON.stringify(t.input, null, 2)}</pre>
        {t.output_preview !== undefined && (
          <>
            <strong>{t.denied ? 'Denied' : t.is_error ? 'Error' : 'Output'}</strong>
            <pre>{t.output_preview || '(empty)'}</pre>
          </>
        )}
      </div>
    </Accordion>
  );
}

/** "3 tool calls, 2 messages" with the tools' icons; opens the steps before the answer. */
export function StepsSummary({ tools, messages, open, onToggle }: { tools: ToolEvent[]; messages: number; open: boolean; onToggle: () => void }) {
  const label = [plural(tools.length, 'tool call'), messages ? plural(messages, 'message') : ''].filter(Boolean).join(', ');
  return (
    <button className="steps-summary" onClick={onToggle} aria-expanded={open} data-open={open}>
      <span className="steps-chevron">{ICONS.chevron}</span>
      <span>{label}</span>
      <span className="steps-icons" aria-hidden>
        {tools.slice(0, 6).map((t) => (
          <span key={t.id}>{toolIcon(t.name)}</span>
        ))}
        {tools.length > 6 && <span className="steps-more">+{tools.length - 6}</span>}
      </span>
    </button>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The first line of a thinking summary, without its markdown emphasis. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/[*_`#]+/g, '').trim();
}

export function prettyTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}·${m[2]}` : name;
}

export function toolSummary(t: ToolEvent): string {
  const i = (t.input ?? {}) as Record<string, any>;
  const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.action ?? '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function toolIcon(name: string) {
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return ICONS.terminal;
  if (name === 'Read') return ICONS.file;
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return ICONS.pencil;
  if (name === 'Grep' || name === 'Glob' || name === 'ToolSearch') return ICONS.search;
  if (name === 'WebFetch' || name === 'WebSearch') return ICONS.globe;
  if (name === 'Agent' || name === 'Task') return ICONS.agent;
  return ICONS.wrench;
}
