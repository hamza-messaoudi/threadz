import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Conversation, type Mention, type Message } from '../lib/api.ts';
import { navigate, type Route } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { useThread } from '../lib/useThread.ts';
import { ChannelSettings } from './ChannelSettings.tsx';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { ThreadPanel } from './ThreadPanel.tsx';

interface Props {
  conversationId: string;
  conversation?: Conversation;
  route: Route;
}

export function ConversationView({ conversationId, conversation, route }: Props) {
  if (conversationId === 'new') return <NewChat />;
  if (!conversation) return <MissingConversation id={conversationId} route={route} />;
  return <Loaded conversation={conversation} route={route} />;
}

/** Not in the sidebar list: still loading, or archived (search results can point there). */
function MissingConversation({ id, route }: { id: string; route: Route }) {
  const [conv, setConv] = useState<Conversation | null | undefined>(undefined);
  useEffect(() => {
    api.get<Conversation>(`/api/conversations/${id}`).then(setConv, () => setConv(null));
  }, [id]);
  if (conv) return <Loaded conversation={conv} route={route} />;
  return <div className="empty-state muted">{conv === null ? 'This conversation does not exist.' : 'Loading…'}</div>;
}

/** Draft view for "New chat": the chat is created (and named) when the first message is sent. */
function NewChat() {
  const { upsertConversation } = useAppData();
  const send = async (text: string, mentions: Mention[]) => {
    const c = await api.post<Conversation>('/api/conversations', { kind: 'chat' });
    await api.post(`/api/threads/${c.rootThreadId}/messages`, { text, mentions });
    upsertConversation({ ...c, name: text.replace(/\s+/g, ' ').slice(0, 40) });
    navigate({ view: 'conversation', conversationId: c.id }, true);
  };
  return (
    <div className="conversation">
      <div className="conv-main">
        <header className="conv-head">
          <h2>New chat</h2>
        </header>
        <div className="messages-scroll">
          <div className="empty-state">
            <h3>Start a chat</h3>
            <p className="muted">Tag an agent with @ or a workflow. Chats run in the scratch folder unless you tag a directory with #.</p>
          </div>
        </div>
        <Composer draftKey="new-chat" conversation={null} defaultAgent={null} placeholder="Message a new chat…" onSend={send} autoFocus />
      </div>
    </div>
  );
}

function Loaded({ conversation, route }: { conversation: Conversation; route: Route }) {
  const t = useThread(conversation.rootThreadId);
  const [settings, setSettings] = useState(false);
  const [activeSource, setActiveSource] = useState<{ messageId: string; blockIndex: number } | null>(null);
  const [floating, setFloating] = useState<{ x: number; y: number; messageId: string; blockIndex: number } | null>(null);
  const messagesRef = useRef(t.messages);
  messagesRef.current = t.messages;
  const { routines } = useAppData();
  const routine = conversation.routineId ? routines.find((r) => r.name === conversation.routineId) : undefined;

  const send = useCallback(
    async (text: string, mentions: Mention[]) => {
      await api.post(`/api/threads/${conversation.rootThreadId}/messages`, { text, mentions });
    },
    [conversation.rootThreadId],
  );

  const openThread = useCallback(
    async (m: Message, blockIndex: number) => {
      const th = await api.post<{ id: string }>('/api/threads', { message_id: m.id, block_index: blockIndex });
      navigate({ view: 'conversation', conversationId: conversation.id, threadId: th.id });
    },
    [conversation.id],
  );

  // Selecting text snaps to its paragraph (the block holding the selection start) and offers "Thread".
  const onMouseUp = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setFloating(null);
      const range = sel.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : (range.startContainer as HTMLElement);
      let block = start?.closest<HTMLElement>('[data-block]');
      const msgEl = (block ?? start)?.closest<HTMLElement>('[data-message-id]');
      if (!msgEl || msgEl.closest('.thread-panel')) return setFloating(null);
      if (!block) block = msgEl.querySelector<HTMLElement>('[data-block]'); // selection began above the first block
      const m = messagesRef.current.find((x) => x.id === msgEl.dataset.messageId);
      if (!block || !m || m.status !== 'done' || m.authorKind === 'system') return setFloating(null);
      const rect = range.getBoundingClientRect();
      setFloating({ x: Math.min(rect.right, window.innerWidth - 90), y: Math.max(rect.top - 34, 8), messageId: m.id, blockIndex: Number(block.dataset.block) });
    }, 0);
  }, []);

  const closePanel = useCallback(() => navigate({ view: 'conversation', conversationId: conversation.id }), [conversation.id]);
  return (
    <div className={`conversation ${conversation.yolo ? 'yolo' : ''}`}>
      <div className="conv-main">
        <header className="conv-head">
          <h2>
            {conversation.kind !== 'chat' && <span className="hash">#</span>}
            {conversation.name}
          </h2>
          {conversation.yolo && <span className="yolo-label">YOLO</span>}
          {conversation.dir && (
            <span className="conv-dir" title={conversation.dir}>
              {conversation.dir}
            </span>
          )}
          <span className="spacer" />
          {routine && (
            <button className="btn small" onClick={() => api.post(`/api/routines/${encodeURIComponent(routine.name)}/run`)} disabled={routine.status === 'running'}>
              {routine.status === 'running' ? 'Running…' : 'Run now'}
            </button>
          )}
          <button className="btn ghost" onClick={() => setSettings(true)}>
            Settings
          </button>
        </header>
        <div className="scroll-host" onMouseUp={onMouseUp} onMouseDown={() => setFloating(null)}>
        <ScrollArea messages={t.messages} focusId={route.threadId ? undefined : route.messageId}>
          {t.loading ? (
            <div className="empty-state muted">Loading…</div>
          ) : t.messages.length === 0 ? (
            <EmptyConversation conversation={conversation} />
          ) : (
            <MessageList
              messages={t.messages}
              childThreads={t.childThreads}
              runs={t.runs}
              onOpenThread={openThread}
              allowThreads
              activeSource={route.threadId ? activeSource : null}
              focusId={route.threadId ? undefined : route.messageId}
            />
          )}
        </ScrollArea>
        </div>
        <Composer
          draftKey={conversation.rootThreadId}
          conversation={conversation}
          defaultAgent={t.defaultAgent}
          placeholder={`Message ${conversation.kind === 'chat' ? conversation.name : '#' + conversation.name}`}
          onSend={send}
          autoFocus
        />
      </div>
      {route.threadId && (
        <ThreadPanel
          key={route.threadId}
          threadId={route.threadId}
          conversation={conversation}
          focusId={route.messageId}
          onClose={closePanel}
          onSource={setActiveSource}
        />
      )}
      {floating && (
        <button
          className="floating-thread-btn"
          style={{ left: floating.x, top: floating.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const m = t.messages.find((x) => x.id === floating.messageId);
            setFloating(null);
            window.getSelection()?.removeAllRanges();
            if (m) openThread(m, floating.blockIndex);
          }}
        >
          💬 Thread
        </button>
      )}
      {settings && <ChannelSettings conversation={conversation} onClose={() => setSettings(false)} />}
    </div>
  );
}

function EmptyConversation({ conversation }: { conversation: Conversation }) {
  return (
    <div className="empty-state">
      <h3>{conversation.kind === 'chat' ? 'Empty chat' : `Welcome to #${conversation.name}`}</h3>
      <p className="muted">
        Tag an agent with <strong>@</strong> to start. Tag several to run them in parallel, or tag a workflow to run its steps in order.
        {conversation.kind === 'channel' && ' Use # to run in another directory.'}
      </p>
    </div>
  );
}

/** Keeps the view pinned to the bottom while new content streams in, unless the user scrolled up. */
export function ScrollArea({ messages, children, focusId }: { messages: Message[]; children: React.ReactNode; focusId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const onScroll = () => {
    const el = ref.current!;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const last = messages[messages.length - 1];
  const signature = `${messages.length}:${last?.content.length}:${last?.status}:${last?.toolEvents.length}`;
  useLayoutEffect(() => {
    if (focusId) return;
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [signature, focusId]);
  return (
    <div className="messages-scroll" ref={ref} onScroll={onScroll}>
      {children}
    </div>
  );
}
