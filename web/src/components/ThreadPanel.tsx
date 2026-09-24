import { useCallback, useEffect, useState } from 'react';
import { api, type Conversation, type Mention } from '../lib/api.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { agentColor } from '../lib/store.tsx';
import { useThread } from '../lib/useThread.ts';
import { Composer } from './Composer.tsx';
import { ScrollArea } from './ConversationView.tsx';
import { MessageList } from './MessageList.tsx';

interface Props {
  threadId: string;
  conversation: Conversation;
  focusId?: string;
  onClose: () => void;
  onSource: (s: { messageId: string; blockIndex: number } | null) => void;
}

export function ThreadPanel({ threadId, conversation, focusId, onClose, onSource }: Props) {
  const t = useThread(threadId);
  const [collapsed, setCollapsed] = useState(false);
  const info = t.data?.thread;
  const source = t.data?.sourceMessage;

  useEffect(() => {
    if (info?.parentMessageId != null && info.blockIndex != null) onSource({ messageId: info.parentMessageId, blockIndex: info.blockIndex });
    return () => onSource(null);
  }, [info?.parentMessageId, info?.blockIndex, onSource]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const send = useCallback(
    async (text: string, mentions: Mention[]) => {
      await api.post(`/api/threads/${threadId}/messages`, { text, mentions });
    },
    [threadId],
  );

  const sourceAuthor = source ? (source.authorKind === 'agent' ? `@${source.authorId}` : source.authorKind === 'user' ? 'you' : 'app') : '';

  return (
    <aside className="thread-panel">
      <header className="conv-head">
        <h2>Thread</h2>
        <span className="conv-dir">{conversation.kind === 'chat' ? conversation.name : `#${conversation.name}`}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </header>
      {info?.blockText && (
        <div className={`quote ${collapsed ? 'collapsed' : ''}`}>
          <div className="quote-head">
            <span style={source?.authorKind === 'agent' ? { color: agentColor(source.authorId) } : undefined}>{sourceAuthor}</span>
            <button className="link" onClick={() => setCollapsed(!collapsed)}>
              {collapsed ? 'Expand' : 'Collapse'}
            </button>
          </div>
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(info.blockText) }} />
        </div>
      )}
      <ScrollArea messages={t.messages} focusId={focusId}>
        {t.loading ? (
          <div className="empty-state muted">Loading…</div>
        ) : t.messages.length === 0 ? (
          <div className="empty-state muted">Ask about this passage. The main conversation is not affected.</div>
        ) : (
          <MessageList messages={t.messages} runs={t.runs} focusId={focusId} />
        )}
      </ScrollArea>
      <Composer draftKey={threadId} conversation={conversation} defaultAgent={t.defaultAgent} placeholder="Reply in thread…" onSend={send} autoFocus />
    </aside>
  );
}
