import { CaretDown, CaretUp, FileMd, FilePdf } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Conversation, type Mention } from '../lib/api.ts';
import { agentColor } from '../lib/store.tsx';
import { useThread } from '../lib/useThread.ts';
import { MessageMarkdown } from '../markdown/MessageMarkdown.tsx';
import { Composer } from './Composer.tsx';
import { MessageSkeleton, SkeletonReveal, SwapText, useResizeHeight } from './transitions.tsx';
import { ScrollArea } from './ConversationView.tsx';
import { MessageList, type Passage } from './MessageList.tsx';
import { ICONS } from './icons.tsx';
import { PromoteThreadDialog } from './PromoteThreadDialog.tsx';
import { navigate } from '../lib/router.ts';
import type { PresencePhase } from '../lib/usePresence.ts';

/** Replies after which the panel suggests giving the thread its own channel. */
export const LONG_THREAD = 10;
const NUDGE_KEY = 'threads:promote-nudge-dismissed';

function nudgeDismissed(threadId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(NUDGE_KEY) ?? '[]') as string[]).includes(threadId);
  } catch {
    return false;
  }
}

function dismissNudge(threadId: string) {
  try {
    const ids = (JSON.parse(localStorage.getItem(NUDGE_KEY) ?? '[]') as string[]).filter((x) => x !== threadId);
    localStorage.setItem(NUDGE_KEY, JSON.stringify([...ids, threadId].slice(-200)));
  } catch {
    // storage unavailable: the nudge comes back next time
  }
}

/** A thread on a shared document: which one, where, and the way to the document's other threads. */
export interface DocNav {
  name: string;
  /** The heading the passage sits under. */
  section: string | null;
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** A PDF: its passages are plain text, quoted as such. */
  pdf?: boolean;
}

interface Props {
  threadId: string;
  conversation: Conversation;
  focusId?: string;
  onClose: () => void;
  onSource: (s: Passage | null) => void;
  phase: PresencePhase;
  doc?: DocNav | null;
  /** Reached with previous / next: the passage and replies come in from that side. */
  enter?: 'up' | 'down';
}

export function ThreadPanel({ threadId, conversation, focusId, onClose, onSource, phase, doc, enter }: Props) {
  const t = useThread(threadId);
  const [collapsed, setCollapsed] = useState(false);
  const quoteBody = useRef<HTMLDivElement>(null);
  useResizeHeight(quoteBody, collapsed ? '3.2em' : 'auto');
  const info = t.data?.thread;
  const source = t.data?.sourceMessage;
  const [promoting, setPromoting] = useState(false);
  const [nudgeOff, setNudgeOff] = useState(() => nudgeDismissed(threadId));
  const replies = t.messages.filter((m) => m.authorKind !== 'system').length;
  const busy = t.messages.some((m) => m.status === 'queued' || m.status === 'streaming');

  // Merged into another thread by a wider pick, or deleted (here or in another tab).
  useEffect(() => {
    if (!t.gone) return;
    if (t.gone.into) navigate({ view: 'conversation', conversationId: conversation.id, threadId: t.gone.into }, true);
    else onClose();
  }, [t.gone]);

  // The thread became a channel (here or in another tab; old links too): follow it there.
  useEffect(() => {
    if (info && info.conversationId !== conversation.id) navigate({ view: 'conversation', conversationId: info.conversationId }, true);
  }, [info?.conversationId, conversation.id]);

  useEffect(() => {
    if (info?.parentMessageId != null && info.blockIndex != null) onSource({ messageId: info.parentMessageId, start: info.blockIndex, end: info.blockEnd ?? info.blockIndex });
    return () => onSource(null);
  }, [info?.parentMessageId, info?.blockIndex, info?.blockEnd, onSource]);

  useEffect(() => {
    if (phase === 'closing' || promoting) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, phase, promoting]);

  const send = useCallback(
    async (text: string, mentions: Mention[]) => {
      await api.post(`/api/threads/${threadId}/messages`, { text, mentions });
    },
    [threadId],
  );

  const paragraphs = info?.blockIndex != null && info.blockEnd != null ? info.blockEnd - info.blockIndex + 1 : 1;
  const sourceAuthor = source ? (source.authorKind === 'agent' ? `@${source.authorId}` : source.authorKind === 'user' ? 'you' : 'app') : '';

  return (
    // Card resize opens a column for the panel (the conversation narrows smoothly); panel reveal slides the contents in.
    <aside className={`thread-panel t-resize ${phase === 'open' ? 'is-open' : ''}`} inert={phase === 'closing'}>
      <div className="thread-panel-inner t-panel-slide" data-axis="x" data-open={phase === 'open'} data-enter={enter}>
      <header className="conv-head">
        <h2>Thread</h2>
        <span className="conv-dir">{conversation.kind === 'chat' ? conversation.name : `#${conversation.name}`}</span>
        <span className="spacer" />
        {info && (
          <ConfirmButton
            icon={ICONS.reset}
            label="Reset"
            confirm={`Clear ${replies} ${replies === 1 ? 'reply' : 'replies'}?`}
            tooltip="Start over: clears the replies. Agents pick up from the main conversation again."
            disabled={!replies || busy}
            onConfirm={() => api.post(`/api/threads/${threadId}/reset`)}
          />
        )}
        {info && (
          <ConfirmButton
            icon={ICONS.trash}
            label="Delete"
            confirm="Delete thread?"
            tooltip="Delete this thread and its replies"
            disabled={busy}
            onConfirm={() => api.del(`/api/threads/${threadId}`)}
          />
        )}
        {info && (
          <button className="btn ghost small" onClick={() => setPromoting(true)} data-tooltip="Give this thread its own channel. Agents keep their sessions.">
            {ICONS.hash}
            Make channel
          </button>
        )}
        <button className="btn ghost icon-only" onClick={onClose} data-tooltip="Close (Esc)" aria-label="Close thread">
          {ICONS.close}
        </button>
      </header>
      {info?.blockText && (
        <div className={`quote ${collapsed ? 'collapsed' : ''}`}>
          <div className="quote-head">
            {doc ? (
              <span className="quote-doc">
                {doc.pdf ? <FilePdf size={14} aria-hidden /> : <FileMd size={14} aria-hidden />}
                <span className="quote-doc-name">{doc.name}</span>
                {doc.section && <span className="quote-doc-section">· {doc.section}</span>}
              </span>
            ) : (
              <span style={source?.authorKind === 'agent' ? { color: agentColor(source.authorId) } : undefined}>{sourceAuthor}</span>
            )}
            {paragraphs > 1 && <span className="muted">· {paragraphs} paragraphs</span>}
            <span className="spacer" />
            {doc && doc.total > 1 && (
              <span className="doc-nav">
                <button className="doc-nav-btn" onClick={doc.onPrev} disabled={!doc.onPrev} data-tooltip="Previous thread in the document" aria-label="Previous thread in the document">
                  <CaretUp size={13} />
                </button>
                <span className="doc-nav-count">
                  {doc.index + 1} / {doc.total}
                </span>
                <button className="doc-nav-btn" onClick={doc.onNext} disabled={!doc.onNext} data-tooltip="Next thread in the document" aria-label="Next thread in the document">
                  <CaretDown size={13} />
                </button>
              </span>
            )}
            <button className="link" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
              <SwapText text={collapsed ? 'Expand' : 'Collapse'} />
            </button>
          </div>
          <div ref={quoteBody} className="quote-clip t-resize">
            {doc?.pdf ? (
              <div className="quote-body quote-plain">
                {info.blockText.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            ) : (
              <MessageMarkdown id={`quote:${threadId}`} content={info.blockText} className="quote-body" />
            )}
          </div>
        </div>
      )}
      <ScrollArea messages={t.messages} focusId={focusId}>
        <SkeletonReveal loaded={!t.loading} skeleton={<MessageSkeleton rows={2} />}>
          {t.loading ? null : t.messages.length === 0 ? (
            <div className="empty-state muted">
              {doc ? 'Ask about this passage. The agent reads the whole document with it.' : 'Ask about this passage. The main conversation is not affected.'}
            </div>
          ) : (
            <MessageList messages={t.messages} runs={t.runs} focusId={focusId} />
          )}
        </SkeletonReveal>
      </ScrollArea>
      {info && replies >= LONG_THREAD && !nudgeOff && (
        <div className="promote-nudge">
          <span>
            {replies} replies. Give it room as its own channel? <span className="muted">Agents keep their context.</span>
          </span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => setPromoting(true)}>
            Make channel
          </button>
          <button
            className="btn ghost small"
            aria-label="Dismiss"
            data-tooltip="Not now"
            onClick={() => {
              dismissNudge(threadId);
              setNudgeOff(true);
            }}
          >
            {ICONS.close}
          </button>
        </div>
      )}
      <Composer draftKey={threadId} conversation={conversation} defaultAgent={t.defaultAgent} cwd={info?.cwd} placeholder="Reply in thread…" onSend={send} autoFocus />
      </div>
      {promoting && info && <PromoteThreadDialog thread={info} from={conversation} onClose={() => setPromoting(false)} />}
    </aside>
  );
}

/** An icon action that asks once: the first click arms it for a few seconds and says what it will do, the second one acts. */
function ConfirmButton({ icon, label, confirm, tooltip, disabled, onConfirm }: { icon: ReactNode; label: string; confirm: string; tooltip: string; disabled?: boolean; onConfirm: () => Promise<unknown> }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn ghost small confirm-btn ${armed ? 'armed' : 'icon-only'}`}
      disabled={disabled}
      data-tooltip={armed ? undefined : tooltip}
      aria-label={armed ? confirm : label}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm().catch(() => {});
      }}
    >
      {icon}
      {armed && <span className="confirm-text">{confirm}</span>}
    </button>
  );
}
