import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Conversation, type Mention, type Message, type ThreadData } from '../lib/api.ts';
import { tildify } from '../lib/dirs.ts';
import { navigate, type Route } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { usePresence } from '../lib/usePresence.ts';
import { useThread } from '../lib/useThread.ts';
import { ChannelSettings } from './ChannelSettings.tsx';
import { MessageMarkdown } from '../markdown/MessageMarkdown.tsx';
import { Composer } from './Composer.tsx';
import { MessageList, type Passage } from './MessageList.tsx';
import { ThreadPanel } from './ThreadPanel.tsx';
import { MessageSkeleton, SkeletonReveal, SwapText, TextsReveal } from './transitions.tsx';

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
  const { upsertConversation, config } = useAppData();
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
          <TextsReveal className="empty-state">
            <h3 className="t-stagger-line t-stagger-line--1">Start a chat</h3>
            <p className="muted t-stagger-line t-stagger-line--2">
              Tag an agent with <strong>@</strong> or a workflow. Chats run in the scratch folder. Tag a folder with <strong>#</strong> to let the agent
              read it, or pick it with <strong>⇧↵</strong> to move the chat into it. Type a new name after # to create a fresh project folder{config?.dirRoots[0] ? ` in ${tildify(config.dirRoots[0], config.homeDir)}` : ''}.
            </p>
          </TextsReveal>
        </div>
        <Composer draftKey="new-chat" conversation={null} defaultAgent={null} placeholder="Message a new chat…" onSend={send} autoFocus />
      </div>
    </div>
  );
}

function Loaded({ conversation, route }: { conversation: Conversation; route: Route }) {
  const t = useThread(conversation.rootThreadId);
  const [settings, setSettings] = useState(false);
  const [activeSource, setActiveSource] = useState<Passage | null>(null);
  // Blocks picked for a new thread (by dragging or shift-clicking 💬), shown with a "Thread" button at x, y.
  const [pending, setPending] = useState<(Passage & { anchor: number; x: number; y: number }) | null>(null);
  const messagesRef = useRef(t.messages);
  messagesRef.current = t.messages;
  const { routines, config } = useAppData();
  const routine = conversation.routineId ? routines.find((r) => r.name === conversation.routineId) : undefined;

  const send = useCallback(
    async (text: string, mentions: Mention[]) => {
      await api.post(`/api/threads/${conversation.rootThreadId}/messages`, { text, mentions });
    },
    [conversation.rootThreadId],
  );

  // Opening the passage whose thread is already open closes the panel instead: one click opens, the next closes.
  const openThreadId = useRef(route.threadId);
  openThreadId.current = route.threadId;
  const openThread = useCallback(
    async (m: Message, start: number, end = start) => {
      setPending(null);
      const th = await api.post<{ id: string; conversationId: string }>('/api/threads', { message_id: m.id, block_index: start, block_end: end });
      // The passage's thread has become its own channel.
      if (th.conversationId !== conversation.id) navigate({ view: 'conversation', conversationId: th.conversationId });
      else if (th.id === openThreadId.current) navigate({ view: 'conversation', conversationId: conversation.id });
      else navigate({ view: 'conversation', conversationId: conversation.id, threadId: th.id });
    },
    [conversation.id],
  );

  const threadable = (id: string | undefined) => {
    const m = messagesRef.current.find((x) => x.id === id);
    return m && m.status === 'done' && m.authorKind !== 'system' ? m : undefined;
  };

  // A text selection snaps to whole blocks: every block it touches in the message where it starts.
  const onMouseUp = useCallback(() => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return; // a plain click; mousedown already cleared
      const range = sel.getRangeAt(0);
      const elOf = (n: globalThis.Node) => (n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as HTMLElement));
      const startEl = elOf(range.startContainer);
      const msgEl = startEl?.closest<HTMLElement>('[data-message-id]');
      if (!msgEl || msgEl.closest('.thread-panel')) return setPending(null);
      const blocks = Array.from(msgEl.querySelectorAll<HTMLElement>('[data-block]'));
      const m = threadable(msgEl.dataset.messageId);
      if (!blocks.length || !m) return setPending(null);
      const inMsg = (el: HTMLElement | null | undefined) => (el && msgEl.contains(el) ? el.closest<HTMLElement>('[data-block]') : null);
      let first = inMsg(startEl) ?? blocks[0]; // selection began above the first block
      let last = inMsg(elOf(range.endContainer)) ?? blocks[blocks.length - 1]; // or ended past this message
      // Dragging to the very start of the next paragraph (or from the very end of one) selects no text there.
      const touches = (b: HTMLElement) => {
        const r = document.createRange();
        r.selectNodeContents(b);
        if (b.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset);
        if (b.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset);
        return r.toString().trim() !== '';
      };
      let a = blocks.indexOf(first);
      let z = blocks.indexOf(last);
      if (z > a && !touches(last)) z--;
      if (a < z && !touches(first)) a++;
      first = blocks[a];
      last = blocks[z];
      const rect = range.getBoundingClientRect();
      const start = Number(first.dataset.block);
      setPending({ messageId: m.id, start, end: Number(last.dataset.block), anchor: start, x: Math.min(rect.right, window.innerWidth - 190), y: Math.max(rect.top - 34, 8) });
    }, 0);
  }, []);

  // Shift-click 💬: the first one anchors the passage, each next one moves its other end.
  const extendPassage = useCallback(
    (m: Message, index: number, at: DOMRect) => {
      window.getSelection()?.removeAllRanges();
      setPending((p) => {
        const anchor = p?.messageId === m.id ? p.anchor : activeSource?.messageId === m.id ? activeSource.start : index;
        return { messageId: m.id, anchor, start: Math.min(anchor, index), end: Math.max(anchor, index), x: at.left, y: Math.max(at.top - 32, 8) };
      });
    },
    [activeSource],
  );

  useEffect(() => {
    if (!pending) return;
    // Capture phase, so Esc drops the pending passage before the thread panel sees it.
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPending(null);
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [!!pending]);

  // The thread panel stays mounted while it slides out (transitions.dev panel reveal).
  const panel = usePresence(route.threadId, '--panel-close-dur', 350);
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
          {t.data?.thread.moved ? (
            <>
              <span className="conv-dir moved" title={`This thread was moved to ${t.data.thread.cwd}`}>
                → {tildify(t.data.thread.cwd, config?.homeDir)}
              </span>
              <button className="btn ghost small" onClick={() => api.patch(`/api/threads/${conversation.rootThreadId}`, { dir: null })} data-tooltip={`Run in ${conversation.dir ?? 'the scratch folder'} again`}>
                Move back
              </button>
            </>
          ) : (
            conversation.dir && (
              <span className="conv-dir" title={conversation.dir}>
                {conversation.dir}
              </span>
            )
          )}
          <span className="spacer" />
          {routine && (
            <button className="btn small" onClick={() => api.post(`/api/routines/${encodeURIComponent(routine.name)}/run`)} disabled={routine.status === 'running'}>
              <SwapText text={routine.status === 'running' ? 'Running…' : 'Run now'} />
            </button>
          )}
          <button className="btn ghost" onClick={() => setSettings(true)}>
            Settings
          </button>
        </header>
        <div className="scroll-host" onMouseUp={onMouseUp} onMouseDown={() => setPending(null)}>
        <ScrollArea messages={t.messages} focusId={route.threadId ? undefined : route.messageId}>
          <SkeletonReveal loaded={!t.loading} skeleton={<MessageSkeleton />}>
            {!t.loading && t.data?.origin && <OriginCard data={t.data} />}
            {t.loading ? null : t.messages.length === 0 ? (
              <EmptyConversation conversation={conversation} />
            ) : (
              <MessageList
                messages={t.messages}
                childThreads={t.childThreads}
                runs={t.runs}
                onOpenThread={openThread}
                onExtendPassage={extendPassage}
                allowThreads
                activeSource={route.threadId ? activeSource : null}
                pending={pending}
                focusId={route.threadId ? undefined : route.messageId}
              />
            )}
          </SkeletonReveal>
        </ScrollArea>
        </div>
        <Composer
          draftKey={conversation.rootThreadId}
          conversation={conversation}
          defaultAgent={t.defaultAgent}
          cwd={t.data?.thread.cwd}
          placeholder={`Message ${conversation.kind === 'chat' ? conversation.name : '#' + conversation.name}`}
          onSend={send}
          autoFocus
        />
      </div>
      {panel.shown && (
        <ThreadPanel
          key={panel.shown}
          threadId={panel.shown}
          phase={panel.phase}
          conversation={conversation}
          focusId={route.messageId}
          onClose={closePanel}
          onSource={setActiveSource}
        />
      )}
      {pending && (
        <button
          className="floating-thread-btn"
          style={{ left: pending.x, top: pending.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const m = t.messages.find((x) => x.id === pending.messageId);
            window.getSelection()?.removeAllRanges();
            if (m) openThread(m, pending.start, pending.end);
          }}
        >
          💬 Thread{pending.end > pending.start && <span className="count"> · {pending.end - pending.start + 1} paragraphs</span>}
        </button>
      )}
      {settings && <ChannelSettings conversation={conversation} onClose={() => setSettings(false)} />}
    </div>
  );
}

/** Top of a channel that grew out of a side thread: the passage it started from, linked back to its place. */
function OriginCard({ data }: { data: ThreadData }) {
  const { origin, thread, sourceMessage: source } = data;
  const [open, setOpen] = useState(false);
  if (!origin || !thread.blockText) return null;
  const where = origin.conversationKind === 'chat' ? origin.conversationName : `#${origin.conversationName}`;
  const author = source ? (source.authorKind === 'agent' ? `@${source.authorId}` : source.authorKind === 'user' ? 'you' : 'app') : '';
  return (
    <div className={`origin-card quote ${open ? '' : 'collapsed'}`}>
      <div className="quote-head">
        <span>
          Grew out of a thread in{' '}
          <button
            className="link"
            onClick={() => navigate({ view: 'conversation', conversationId: origin.conversationId, messageId: thread.parentMessageId ?? undefined })}
            data-tooltip="Show the passage where it started"
          >
            {where}
          </button>
          {author && <span className="muted"> · on a passage by {author}</span>}
        </span>
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          <SwapText text={open ? 'Collapse' : 'Expand'} />
        </button>
      </div>
      <div className="quote-clip" style={open ? undefined : { maxHeight: '3.2em' }}>
        <MessageMarkdown id={`origin:${thread.id}`} content={thread.blockText} className="quote-body" />
      </div>
    </div>
  );
}

function EmptyConversation({ conversation }: { conversation: Conversation }) {
  return (
    <TextsReveal className="empty-state">
      <h3 className="t-stagger-line t-stagger-line--1">{conversation.kind === 'chat' ? 'Empty chat' : `Welcome to #${conversation.name}`}</h3>
      <p className="muted t-stagger-line t-stagger-line--2">
        Tag an agent with <strong>@</strong> to start. Tag several to run them in parallel, or tag a workflow to run its steps in order.
        {' Tag a folder with # to let the agent read it, or pick it with ⇧↵ to move this conversation into it.'}
      </p>
    </TextsReveal>
  );
}

/**
 * Keeps the view pinned to the bottom while new content streams in, unless the user scrolled up.
 * A new message jumps there; text growing inside one glides, so each new line does not jolt the view.
 */
export function ScrollArea({ messages, children, focusId }: { messages: Message[]; children: React.ReactNode; focusId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const glide = useRef({ frame: 0, last: 0 });
  // Only the user unpins: layout shifts and scroll anchoring move scrollTop too.
  const userAt = useRef(-Infinity);
  const touched = () => {
    userAt.current = performance.now();
  };
  const onScroll = () => {
    const el = ref.current!;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) pinned.current = true;
    else if (performance.now() - userAt.current < 600) pinned.current = false;
  };
  const jump = () => {
    const el = ref.current;
    if (!el || !pinned.current) return;
    cancelAnimationFrame(glide.current.frame);
    glide.current.frame = 0;
    el.scrollTop = el.scrollHeight;
  };
  const follow = () => {
    const g = glide.current;
    const el = ref.current;
    if (g.frame || !pinned.current || !el) return;
    // More than a screen to go (a thread loading, not a line being written) jumps.
    if (el.scrollHeight - el.clientHeight - el.scrollTop > el.clientHeight || matchMedia('(prefers-reduced-motion: reduce)').matches) return jump();
    const tick = (now: number) => {
      const el = ref.current;
      const dt = g.last ? Math.min(now - g.last, 100) : 16;
      g.last = now;
      const gap = el ? el.scrollHeight - el.clientHeight - el.scrollTop : 0;
      if (!el || !pinned.current || gap < 0.5) {
        g.frame = g.last = 0;
        return;
      }
      // Ease toward the bottom with a ~90 ms time constant.
      el.scrollTop += Math.max(1, gap * (1 - Math.exp(-dt / 90)));
      g.frame = requestAnimationFrame(tick);
    };
    g.frame = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(glide.current.frame), []);

  const last = messages[messages.length - 1];
  const count = `${messages.length}:${last?.id}`;
  useLayoutEffect(() => {
    if (!focusId) jump();
  }, [count, focusId]);
  // Streaming text, steps, parses and figures settling all resize the list: follow them.
  useEffect(() => {
    const el = ref.current;
    if (!el || focusId || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(follow);
    const observe = () => {
      ro.disconnect();
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observe();
    // The skeleton hands over to the list as a new child: watch that one too.
    const mo = new MutationObserver(observe);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [focusId]);
  return (
    <div
      className="messages-scroll"
      ref={ref}
      onScroll={onScroll}
      onWheel={touched}
      onTouchMove={touched}
      onKeyDown={touched}
      onPointerDown={touched}
    >
      {children}
    </div>
  );
}
