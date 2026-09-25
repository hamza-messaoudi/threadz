import { useLayoutEffect, useReducer, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Message, ThinkingEvent, ToolEvent } from '../lib/api.ts';
import { parseMessage } from '../markdown/parse.ts';
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

const svg = (d: ReactNode, box = 16) => (
  <svg viewBox={`0 0 ${box} ${box}`} width="15" height="15" fill="none" stroke="currentColor" strokeWidth={(1.3 * box) / 16} strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const ICONS = {
  chevron: svg(<path d="M6 4l4 4-4 4" />),
  terminal: svg(<path d="M2.5 4.5l3.5 3.5-3.5 3.5M8 12h5.5" />),
  wrench: svg(<path d="M10.2 2.6a3.2 3.2 0 0 0-3.9 4.2L2.6 10.5a1.4 1.4 0 0 0 2 2l3.7-3.7a3.2 3.2 0 0 0 4.2-3.9l-2 2-1.6-.4-.4-1.6z" />),
  file: svg(<path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" />),
  pencil: svg(<path d="M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3" />),
  search: svg(
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>,
  ),
  globe: svg(
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8M8 2.2C6.4 3.9 5.6 5.8 5.6 8s.8 4.1 2.4 5.8" />
    </>,
  ),
  agent: svg(<path d="M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z" />),
  lock: svg(
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ),
  // Lucide's brain.
  brain: svg(
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18" />,
    24,
  ),
};
