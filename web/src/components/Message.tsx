import { memo, useMemo, useState } from 'react';
import { api, type ChildThread, type Message as Msg, type Run, type ToolEvent } from '../lib/api.ts';
import { MessageMarkdown } from '../markdown/MessageMarkdown.tsx';
import { agentColor, useAppData } from '../lib/store.tsx';
import { WorkflowCard } from './WorkflowCard.tsx';

export interface MessageProps {
  m: Msg;
  childThreads?: ChildThread[];
  run?: Run;
  activeBlock?: number | null;
  onOpenThread?: (m: Msg, blockIndex: number) => void;
  allowThreads?: boolean;
  flash?: boolean;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const MessageView = memo(function MessageView(props: MessageProps) {
  const { m } = props;
  if (m.authorKind === 'system') return <SystemMessage {...props} />;
  const isAgent = m.authorKind === 'agent';
  const name = isAgent ? (m.authorId ?? 'agent') : 'you';
  const color = isAgent ? agentColor(m.authorId) : undefined;
  const live = m.status === 'streaming' || m.status === 'queued';

  return (
    <div className={`msg ${props.flash ? 'flash' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
      <div className={`avatar ${isAgent ? '' : 'user'}`} style={color ? { background: color } : undefined}>
        {name.slice(0, 1).toUpperCase()}
      </div>
      <div className="msg-content">
        {m.markers.map((mk, i) => (
          <div key={i} className="marker">
            {mk}
          </div>
        ))}
        <div className="msg-head">
          <span className="msg-author" style={color ? { color } : undefined}>
            {isAgent ? `@${name}` : name}
          </span>
          <span className="msg-time">{time(m.createdAt)}</span>
          {isAgent && m.status !== 'done' && <span className={`msg-status ${m.status}`}>{statusLabel(m.status)}</span>}
          {isAgent && <CacheBadge m={m} />}
          <span className="msg-actions">
            {live && (
              <button className="icon-btn" onClick={() => api.post(`/api/messages/${m.id}/cancel`)} title="Stop this turn">
                ■ Stop
              </button>
            )}
            {isAgent && m.sessionId && m.cwd && <TerminalButton m={m} />}
          </span>
        </div>
        {m.toolEvents.length > 0 && <ToolChips events={m.toolEvents} />}
        <Body {...props} />
        {m.status === 'streaming' && !m.content && !m.toolEvents.length && <span className="cursor" />}
        {m.status === 'queued' && <div className="muted">Waiting for a free slot…</div>}
        {m.status === 'error' && <ErrorCard m={m} />}
      </div>
    </div>
  );
});

function statusLabel(s: Msg['status']) {
  return s === 'streaming' ? 'working' : s;
}

function Body({ m, childThreads, activeBlock, onOpenThread, allowThreads }: MessageProps) {
  const byBlock = useMemo(() => {
    const map = new Map<number, ChildThread>();
    for (const t of childThreads ?? []) if (t.parentMessageId === m.id) map.set(t.blockIndex, t);
    return map;
  }, [childThreads, m.id]);
  const canThread = allowThreads && m.status === 'done' && !!onOpenThread;
  if (!m.content) return null;
  return (
    <div className="msg-body">
      <MessageMarkdown
        id={m.id}
        content={m.content}
        streaming={m.status === 'streaming'}
        renderBlock={(b, content) => {
          const t = byBlock.get(b.index);
          return (
            <div
              data-block={b.index}
              className={`block ${t ? 'has-thread' : ''} ${activeBlock === b.index ? 'active-source' : ''}`}
              onClick={t && onOpenThread ? (e) => !window.getSelection()?.toString() && !(e.target as HTMLElement).closest('a, button') && onOpenThread(m, b.index) : undefined}
            >
              {canThread && (
                <button
                  className="block-gutter"
                  title="Reply in thread"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenThread!(m, b.index);
                  }}
                >
                  💬
                </button>
              )}
              {content}
              {t && (
                <div className="thread-badge">
                  {t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}
                  <span className="muted">· {relTime(t.lastActivity)}</span>
                </div>
              )}
            </div>
          );
        }}
      />
    </div>
  );
}

export function relTime(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function CacheBadge({ m }: { m: Msg }) {
  const u = m.usage;
  if (!u) return null;
  const f = u.first_call ?? u;
  const read = f.cache_read_input_tokens ?? 0;
  const create = f.cache_creation_input_tokens ?? 0;
  const input = f.input_tokens ?? 0;
  const total = read + create + input;
  if (!total) return null;
  const pct = Math.round((read / total) * 100);
  const title = [
    `First API call of this turn: ${read.toLocaleString()} cache read, ${create.toLocaleString()} cache write, ${input.toLocaleString()} uncached input`,
    `Whole turn: ${(u.cache_read_input_tokens ?? 0).toLocaleString()} read, ${(u.cache_creation_input_tokens ?? 0).toLocaleString()} write, ${(u.input_tokens ?? 0).toLocaleString()} input, ${(u.output_tokens ?? 0).toLocaleString()} output`,
    u.total_cost_usd ? `Cost: $${u.total_cost_usd.toFixed(4)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`cache-badge ${pct >= 80 ? 'hit' : pct < 30 ? 'miss' : ''}`} title={title}>
      cache {pct}%
    </span>
  );
}

function TerminalButton({ m }: { m: Msg }) {
  const { config } = useAppData();
  const [copied, setCopied] = useState(false);
  const cmd = `cd '${m.cwd!.replace(/'/g, `'\\''`)}' && ${config?.claudeBin ?? 'claude'} --resume ${m.sessionId}`;
  return (
    <button
      className="icon-btn"
      title={cmd}
      onClick={async () => {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : 'Open in terminal'}
    </button>
  );
}

export function toolSummary(t: ToolEvent): string {
  const i = (t.input ?? {}) as Record<string, any>;
  const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.action ?? '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function ToolChips({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const sel = events.find((e) => e.id === open);
  return (
    <>
      <div className="tools">
        {events.map((t) => (
          <button
            key={t.id}
            className={`chip-tool ${t.denied ? 'denied' : t.is_error ? 'err' : ''}`}
            onClick={() => setOpen(open === t.id ? null : t.id)}
            title={t.denied ? 'Blocked by the read-only gate' : undefined}
          >
            {t.denied && <span aria-label="denied">🔒</span>}
            <span className="t-name">{prettyTool(t.name)}</span>
            <span className="t-arg">{toolSummary(t)}</span>
            {t.output_preview === undefined && <span className="cursor" style={{ width: 5, height: 10 }} />}
          </button>
        ))}
      </div>
      {sel && (
        <div className="tool-detail">
          <strong>{sel.name}</strong>
          <pre>{JSON.stringify(sel.input, null, 2)}</pre>
          {sel.output_preview !== undefined && (
            <>
              <strong>{sel.denied ? 'Denied' : sel.is_error ? 'Error' : 'Output'}</strong>
              <pre>{sel.output_preview || '(empty)'}</pre>
            </>
          )}
        </div>
      )}
    </>
  );
}

function prettyTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}·${m[2]}` : name;
}

function ErrorCard({ m }: { m: Msg }) {
  const [first, ...rest] = (m.error ?? 'Unknown error').split('\n');
  const routine = m.meta?.routine as string | undefined;
  return (
    <div className="msg-error">
      <strong>{first}</strong>
      {rest.length > 0 && <pre>{rest.join('\n')}</pre>}
      {routine && (
        <div className="row gap" style={{ marginTop: 6 }}>
          <button className="btn small" onClick={() => api.post(`/api/routines/${encodeURIComponent(routine)}/run`)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function SystemMessage({ m, run }: MessageProps) {
  const kind = m.meta?.kind;
  if (kind === 'run_header') return <div className="run-header">{m.content}</div>;
  if (kind === 'routine_error')
    return (
      <div className="system-msg">
        <ErrorCard m={m} />
      </div>
    );
  if (kind === 'workflow_card') return <WorkflowCard m={m} run={run} />;
  if (kind === 'workflow_step')
    return (
      <details className="step-prompt">
        <summary>
          {m.authorId} · step {m.meta.step} prompt for @{m.meta.agent}
        </summary>
        <pre>{m.content}</pre>
      </details>
    );
  return <div className="system-msg">{m.content}</div>;
}
