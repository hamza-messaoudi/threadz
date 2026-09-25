import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileMd } from '@phosphor-icons/react';
import { api, type ChildThread, type Conversation, type Mention, type Message, type ThreadData } from '../lib/api.ts';
import { tildify } from '../lib/dirs.ts';
import { docMeta, outline, sectionAt, shareDocument } from '../lib/document.ts';
import { navigate, type Route } from '../lib/router.ts';
import { play } from '../lib/sound.ts';
import { useAppData } from '../lib/store.tsx';
import { usePresence } from '../lib/usePresence.ts';
import { useThread } from '../lib/useThread.ts';
import { DirButton, EditableTitle } from './ConvHeader.tsx';
import { MessageMarkdown, useParsed } from '../markdown/MessageMarkdown.tsx';
import { Composer } from './Composer.tsx';
import { ContentsHost } from './DocContents.tsx';
import { useDocumentDrop, useDocumentPicker } from './DocumentDrop.tsx';
import { SCROLL_INTENT } from './DocumentMessage.tsx';
import { MessageList, type Passage } from './MessageList.tsx';
import { ICONS } from './icons.tsx';
import { ThreadPanel, type DocNav } from './ThreadPanel.tsx';
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
  // A document instead of a first message: the chat is named after it.
  const shareDoc = async (file: File) => {
    const c = await api.post<Conversation>('/api/conversations', { kind: 'chat' });
    const doc = await shareDocument(c.rootThreadId, file);
    const meta = docMeta(doc)!;
    upsertConversation({ ...c, name: (meta.title ?? meta.name.replace(/\.(md|markdown)$/i, '')).slice(0, 40) });
    navigate({ view: 'conversation', conversationId: c.id }, true);
  };
  const drop = useDocumentDrop(shareDoc, 'as a new chat');
  return (
    <div className="conversation">
      <div className="conv-main" {...drop.bind}>
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
            <DocumentHint className="t-stagger-line t-stagger-line--3" onFile={drop.run} />
          </TextsReveal>
        </div>
        <Composer draftKey="new-chat" conversation={null} defaultAgent={null} placeholder="Message a new chat…" onSend={send} onDocument={shareDoc} autoFocus />
        {drop.overlay}
      </div>
    </div>
  );
}

function Loaded({ conversation, route }: { conversation: Conversation; route: Route }) {
  const t = useThread(conversation.rootThreadId);
  const [activeSource, setActiveSource] = useState<Passage | null>(null);
  // Blocks picked for a new thread (by dragging or shift-clicking the thread button), shown with a "Thread" button at x, y.
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
  const shareDoc = useCallback(
    async (file: File) => {
      await shareDocument(conversation.rootThreadId, file);
    },
    [conversation.rootThreadId],
  );
  const drop = useDocumentDrop(shareDoc, `in ${conversation.kind === 'chat' ? 'this chat' : `#${conversation.name}`}`);

  // Opening the passage whose thread is already open closes the panel instead: one click opens, the next closes.
  const openThreadId = useRef(route.threadId);
  openThreadId.current = route.threadId;
  const openThread = useCallback(
    async (m: Message, start: number, end = start) => {
      setPending(null);
      const th = await api.post<{ id: string; conversationId: string; widened?: boolean }>('/api/threads', { message_id: m.id, block_index: start, block_end: end });
      // The passage's thread has become its own channel.
      if (th.conversationId !== conversation.id) navigate({ view: 'conversation', conversationId: th.conversationId });
      // A pick that only reopens the open thread closes it; one that grew it keeps it open.
      else if (th.id === openThreadId.current && !th.widened) navigate({ view: 'conversation', conversationId: conversation.id });
      else {
        play('thread');
        navigate({ view: 'conversation', conversationId: conversation.id, threadId: th.id });
      }
    },
    [conversation.id],
  );

  const pick = usePick(pending, t.childThreads);

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
      setPending({ messageId: m.id, start, end: Number(last.dataset.block), anchor: start, x: Math.min(rect.right, window.innerWidth - 260), y: Math.max(rect.top - 42, 8) });
    }, 0);
  }, []);

  // Shift-click the thread button: the first one anchors the passage, each next one moves its other end.
  const extendPassage = useCallback(
    (m: Message, index: number, at: DOMRect) => {
      window.getSelection()?.removeAllRanges();
      setPending((p) => {
        const anchor = p?.messageId === m.id ? p.anchor : activeSource?.messageId === m.id ? activeSource.start : index;
        return { messageId: m.id, anchor, start: Math.min(anchor, index), end: Math.max(anchor, index), x: at.left, y: Math.max(at.top - 40, 8) };
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

  // A thread on a document: its place among the document's threads, for the panel's previous / next.
  const [navDir, setNavDir] = useState<{ id: string; dir: 'up' | 'down' } | null>(null);
  const openChild = route.threadId ? t.childThreads.find((c) => c.id === route.threadId) : undefined;
  const docSource = openChild && t.messages.find((m) => m.id === openChild.parentMessageId && docMeta(m));
  // The document is parsed (and cached) for its own view already; this reads the same tree.
  const docParsed = useParsed(docSource?.id ?? '', docSource?.content ?? '', false);
  const docNav = useMemo<DocNav | null>(() => {
    const open = openChild;
    const src = docSource;
    const meta = docMeta(src);
    if (!open || !src || !meta) return null;
    const list = t.childThreads.filter((c) => c.parentMessageId === src.id && !c.channel && c.blockIndex >= 0).sort((a, b) => a.blockIndex - b.blockIndex || a.blockEnd - b.blockEnd);
    const i = list.findIndex((c) => c.id === open.id);
    const parsed = docSource ? docParsed : null;
    const go = (to: ChildThread | undefined, dir: 'up' | 'down') =>
      to &&
      (() => {
        setNavDir({ id: to.id, dir });
        navigate({ view: 'conversation', conversationId: conversation.id, threadId: to.id });
      });
    return {
      name: meta.name,
      section: (parsed && sectionAt(outline(parsed.blocks), open.blockIndex)?.text) || null,
      index: i,
      total: i < 0 ? 0 : list.length,
      onPrev: go(list[i - 1], 'up'),
      onNext: go(list[i + 1], 'down'),
    };
  }, [openChild, docSource, docParsed, t.childThreads, conversation.id]);

  // The thread panel stays mounted while it slides out (transitions.dev panel reveal).
  const panel = usePresence(route.threadId, '--panel-close-dur', 350);
  const closePanel = useCallback(() => navigate({ view: 'conversation', conversationId: conversation.id }), [conversation.id]);
  return (
    <div className={`conversation ${conversation.yolo ? 'yolo' : ''}`}>
      <ContentsHost>
        <div className="conv-main" {...drop.bind}>
          <header className="conv-head">
            <EditableTitle conversation={conversation} />
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
            ) : conversation.kind === 'channel' ? (
              <DirButton conversation={conversation} />
            ) : (
              conversation.dir && (
                <span className="conv-dir" title={conversation.dir}>
                  {tildify(conversation.dir, config?.homeDir)}
                </span>
              )
            )}
            <span className="spacer" />
            {routine && (
              <button className="btn small" onClick={() => api.post(`/api/routines/${encodeURIComponent(routine.name)}/run`)} disabled={routine.status === 'running'}>
                <SwapText text={routine.status === 'running' ? 'Running…' : 'Run now'} />
              </button>
            )}
          </header>
          <div className="scroll-host" onMouseUp={onMouseUp} onMouseDown={() => setPending(null)}>
          <ScrollArea messages={t.messages} focusId={route.threadId ? undefined : route.messageId}>
            <SkeletonReveal loaded={!t.loading} skeleton={<MessageSkeleton />}>
              {!t.loading && t.data?.origin && <OriginCard data={t.data} />}
              {t.loading ? null : t.messages.length === 0 ? (
                <EmptyConversation conversation={conversation} onFile={drop.run} />
              ) : (
                <MessageList
                  messages={t.messages}
                  childThreads={t.childThreads}
                  runs={t.runs}
                  onOpenThread={openThread}
                  onExtendPassage={extendPassage}
                  allowThreads
                  activeSource={route.threadId ? activeSource : null}
                  pending={pick}
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
            onDocument={shareDoc}
            autoFocus
          />
          {drop.overlay}
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
            doc={panel.shown === route.threadId ? docNav : null}
            enter={navDir?.id === panel.shown ? navDir.dir : undefined}
          />
        )}
        {pending && pick && (
          <button
            className="floating-thread-btn"
            style={{ left: pending.x, top: pending.y }}
            disabled={!!pick.channel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const m = t.messages.find((x) => x.id === pending.messageId);
              window.getSelection()?.removeAllRanges();
              if (m) openThread(m, pending.start, pending.end);
            }}
          >
            <span className="step-icon">{pick.channel ? ICONS.hash : ICONS.thread}</span>
            {pick.channel ? (
              <span className="floating-thread-label">Part of this became #{pick.channel}</span>
            ) : (
              <>
                <span className="floating-thread-label">{pick.opens ? 'Open thread' : pick.threads > 1 ? 'Merge threads' : pick.threads ? 'Add to thread' : 'Reply in thread'}</span>
                <span className="step-arg prose">{pick.end > pick.start ? `${pick.end - pick.start + 1} paragraphs` : '1 paragraph'}</span>
              </>
            )}
          </button>
        )}
      </ContentsHost>
    </div>
  );
}

/**
 * What a pick will become, as the server decides it: a block belongs to one thread only, so the pick
 * grows over every thread it touches and they merge. A channel made from a thread cannot merge.
 */
function usePick(pending: Passage | null, threads: ChildThread[]) {
  return useMemo(() => {
    if (!pending) return null;
    const mine = threads.filter((c) => c.parentMessageId === pending.messageId);
    let { start, end } = pending;
    let hit: ChildThread[] = [];
    for (let grew = true; grew; ) {
      hit = mine.filter((c) => c.blockIndex <= end && start <= c.blockEnd);
      const lo = Math.min(start, ...hit.map((c) => c.blockIndex));
      const hi = Math.max(end, ...hit.map((c) => c.blockEnd));
      grew = lo !== start || hi !== end;
      start = lo;
      end = hi;
    }
    const channel = hit.find((c) => c.channel);
    const opens = hit.length === 1 && hit[0].blockIndex === start && hit[0].blockEnd === end;
    return { messageId: pending.messageId, start, end, threads: hit.length, opens, channel: channel && !opens ? channel.channel!.name : null };
  }, [pending, threads]);
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

function EmptyConversation({ conversation, onFile }: { conversation: Conversation; onFile: (file: File) => void }) {
  return (
    <TextsReveal className="empty-state">
      <h3 className="t-stagger-line t-stagger-line--1">{conversation.kind === 'chat' ? 'Empty chat' : `Welcome to #${conversation.name}`}</h3>
      <p className="muted t-stagger-line t-stagger-line--2">
        Tag an agent with <strong>@</strong> to start. Tag several to run them in parallel, or tag a workflow to run its steps in order.
        {' Tag a folder with # to let the agent read it, or pick it with ⇧↵ to move this conversation into it.'}
      </p>
      <DocumentHint className="t-stagger-line t-stagger-line--3" onFile={onFile} />
    </TextsReveal>
  );
}

/** Empty states: a document can be the start of a conversation too. */
function DocumentHint({ className, onFile }: { className?: string; onFile: (file: File) => void }) {
  const picker = useDocumentPicker(onFile);
  return (
    <div className={`doc-hint ${className ?? ''}`}>
      <button className="btn doc-hint-btn" onClick={picker.open}>
        <FileMd size={16} aria-hidden />
        Read a Markdown document
      </button>
      <span className="muted">or drop a .md file here, then thread on any paragraph.</span>
      {picker.input}
    </div>
  );
}

/**
 * Keeps the view pinned to the bottom while new content streams in, unless the user scrolled up.
 * A new message jumps there; text growing inside one glides, so each new line does not jolt the view.
 * A shared document is the exception: the view goes to its start, where reading begins.
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

  // A jump inside a document (contents, threads, fold, an editor opening) is the reader's own scroll,
  // like a wheel: the view stops following the bottom at once, before the content it is about resizes.
  useEffect(() => {
    const el = ref.current;
    const intent = () => {
      touched();
      pinned.current = false;
    };
    el?.addEventListener(SCROLL_INTENT, intent);
    return () => el?.removeEventListener(SCROLL_INTENT, intent);
  }, []);

  const last = messages[messages.length - 1];
  const count = `${messages.length}:${last?.id}`;
  const shown = useRef(false);
  const reveal = useRef(0);
  useLayoutEffect(() => {
    if (focusId) return;
    if (!docMeta(last)) return void jump();
    // Glide up to a document just shared; open straight onto one that ends the conversation. Its text
    // arrives a moment after its header (the parse), and the scroll waits for it, or it would stop short.
    const smooth = shown.current && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    cancelAnimationFrame(glide.current.frame);
    glide.current.frame = 0;
    pinned.current = false;
    let tries = 0;
    const go = () => {
      const el = ref.current;
      const doc = el?.querySelector(`[id="m-${last.id}"]`);
      if (!el || !doc) return;
      if (!doc.querySelector('[data-block]') && tries++ < 30) return void (reveal.current = requestAnimationFrame(go));
      const top = el.scrollTop + doc.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
      el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    };
    go();
    return () => cancelAnimationFrame(reveal.current);
  }, [count, focusId]);
  useEffect(() => {
    if (messages.length) shown.current = true;
  }, [count]);
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
