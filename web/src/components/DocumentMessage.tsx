import { ArrowLineDown, ArrowLineUp, ArrowsInLineVertical, ArrowsOutLineVertical, FileMd, ListDashes } from '@phosphor-icons/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChildThread } from '../lib/api.ts';
import { chunkBlocks, chunkOf, docMeta, excerpt, nodeText, outline, readingTime, sectionAt, trailAt, type Chunk, type DocMeta, type Heading } from '../lib/document.ts';
import { useDropdown } from '../lib/useDropdown.ts';
import { durationVar } from '../lib/usePresence.ts';
import type { Block } from '../markdown/blocks.ts';
import { MarkdownBlocks, useParsed } from '../markdown/MessageMarkdown.tsx';
import type { Parsed } from '../markdown/parse.ts';
import { useContents } from './DocContents.tsx';
import { ICONS } from './icons.tsx';
import { relTime, useBlockRenderer, type MessageProps } from './Message.tsx';
import { PopNumber, SwapText } from './transitions.tsx';

/** A scroll the reader asked for (a jump, not a layout shift): ScrollArea stops following the bottom. */
export const SCROLL_INTENT = 'scrollintent';

const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollerOf = (el: Element | null) => el?.closest<HTMLElement>('.messages-scroll') ?? null;
/** An element's offset in the scroller's content. */
const offsetIn = (scroller: HTMLElement, el: Element) => scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

interface Doc {
  chunks: Chunk[];
  headings: Heading[];
  /** Character offset where each block starts, and the total: where a passage sits in the document. */
  offsets: number[];
  chars: number;
}

interface Jump {
  index: number;
  how: 'start' | 'center';
  smooth: boolean;
  /** Tells two jumps to the same block apart. */
  seq: number;
}

/**
 * A shared Markdown document in the timeline: rendered in full, but only the chunks near the viewport
 * are in the DOM (the rest are placeholders of their measured or estimated height), so a 100-page
 * document scrolls like a short one. A sticky header names it, tracks the section and progress, and
 * leads to its contents, its threads, and the conversation around it.
 */
export const DocumentMessage = memo(function DocumentMessage(props: MessageProps) {
  const { m, childThreads, activeRange, onOpenThread } = props;
  const meta = docMeta(m)!;
  const parsed = useParsed(m.id, m.content, false);
  const doc = useMemo<Doc | null>(() => {
    if (!parsed) return null;
    const offsets: number[] = [];
    let chars = 0;
    for (const b of parsed.blocks) {
      offsets.push(chars);
      chars += nodeText(b.node).length + 40;
    }
    return { chunks: chunkBlocks(parsed.blocks), headings: outline(parsed.blocks), offsets, chars };
  }, [parsed]);
  const threads = useMemo(
    () => (childThreads ?? []).filter((t) => t.parentMessageId === m.id).sort((a, b) => a.blockIndex - b.blockIndex || a.blockEnd - b.blockEnd),
    [childThreads, m.id],
  );
  const renderBlock = useBlockRenderer(props);
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useFolded(m.id);
  const fold = useRef<HTMLDivElement>(null);
  const contents = useContents();
  const contentsOpen = contents?.openId === m.id;

  // ---- windowing: which chunks are rendered ----
  const n = doc?.chunks.length ?? 0;
  const [inView, setInView] = useState<Set<number> | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const heights = useRef(new Map<number, number>());
  const measured = useRef({ px: 0, chars: 0 });
  const jumpChunk = jump && doc ? chunkOf(doc.chunks, jump.index) : -9;
  // Before the first intersection report: the top and the end, where a reader lands.
  const rendered = (k: number) => Math.abs(k - jumpChunk) <= 1 || (inView ? inView.has(k) : k < 2 || k >= n - 2);
  const heightOf = (k: number) => heights.current.get(k) ?? Math.round(doc!.chunks[k].chars * (measured.current.chars ? measured.current.px / measured.current.chars : 0.38));

  useEffect(() => {
    const el = body.current;
    if (!el || !doc) return;
    const io = new IntersectionObserver(
      (entries) =>
        setInView((prev) => {
          const next = new Set(prev ?? [0, 1, n - 2, n - 1]);
          for (const e of entries) {
            const k = Number((e.target as HTMLElement).dataset.chunk);
            if (e.isIntersecting) next.add(k);
            else next.delete(k);
          }
          return prev && prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next;
        }),
      // A screen and a half above and below, so chunks are ready before they scroll in.
      { root: scrollerOf(el), rootMargin: '150% 0px' },
    );
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const t = e.target as HTMLElement;
        if (t.classList.contains('is-placeholder')) continue;
        const k = Number(t.dataset.chunk);
        const h = t.offsetHeight;
        if (!heights.current.has(k)) {
          measured.current.px += h;
          measured.current.chars += doc.chunks[k].chars;
        }
        heights.current.set(k, h);
      }
    });
    for (const c of Array.from(el.children)) {
      io.observe(c);
      ro.observe(c);
    }
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [doc, folded]);

  // ---- jumps: render the target's chunk, then scroll it into place ----
  const jumpTo = useCallback((index: number, how: Jump['how'] = 'center', smooth = true) => setJump({ index, how, smooth, seq: performance.now() }), []);
  useLayoutEffect(() => {
    const scroller = scrollerOf(root.current);
    const el = jump && body.current?.querySelector<HTMLElement>(`[data-block="${jump.index}"]`);
    if (!jump || !scroller || !el) return;
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    const target = () => {
      const top = offsetIn(scroller, el);
      const headH = head.current?.offsetHeight ?? 0;
      return jump.how === 'start' ? top - headH - 12 : top - Math.max(headH + 12, (scroller.clientHeight - el.offsetHeight) / 2);
    };
    const top = target();
    const far = Math.abs(top - scroller.scrollTop) > scroller.clientHeight * 1.5;
    el.classList.remove('doc-target');
    void el.offsetWidth;
    el.classList.add('doc-target');
    if (jump.smooth && !far && !reducedMotion()) return void scroller.scrollTo({ top, behavior: 'smooth' });
    if (jump.smooth && !reducedMotion()) arrive(body.current!);
    scroller.scrollTop = top;
    // The chunks around the target render next and rarely match their estimates: keep it where it landed.
    return settle(scroller, target);
  }, [jump]);

  // The contents pane (ConversationView) lists this document's headings while it is open for it.
  useEffect(() => {
    if (contentsOpen && doc) contents!.publish({ id: m.id, name: meta.name, headings: doc.headings, threads, jump: (index) => jumpTo(index, 'start') });
  }, [contentsOpen, doc, threads, meta.name]);

  // A thread opened elsewhere (the panel's previous / next, a link): bring its passage into view.
  useEffect(() => {
    if (!activeRange || !doc || folded) return;
    const scroller = scrollerOf(root.current);
    const el = body.current?.querySelector(`[data-block="${activeRange.start}"]`);
    if (scroller && el) {
      const r = el.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      if (r.bottom > s.top + (head.current?.offsetHeight ?? 0) && r.top < s.bottom) return;
    }
    jumpTo(activeRange.start);
  }, [activeRange?.start, doc, folded]);

  // ---- fold: the document shrinks to its header, and opens again ----
  // Only a screenful animates (transitions.dev accordion timing): the rest of a long document is
  // off screen either way, and tweening tens of thousands of pixels would just be a blur.
  const opening = useRef(false);
  const toggleFold = () => {
    if (!folded && contentsOpen) contents!.close();
    const scroller = scrollerOf(root.current);
    const wrap = fold.current;
    if (folded || !scroller || !wrap || reducedMotion()) {
      opening.current = folded && !reducedMotion();
      return setFolded(!folded);
    }
    // Bring the header to the top first, so what folds away is the screenful under it.
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    if (root.current!.getBoundingClientRect().top < scroller.getBoundingClientRect().top) scroller.scrollTop = offsetIn(scroller, root.current!) - 8;
    wrap.style.maxHeight = `${Math.min(wrap.scrollHeight, scroller.clientHeight)}px`;
    void wrap.offsetHeight;
    wrap.dataset.fold = 'closing';
    setTimeout(() => setFolded(true), durationVar('--acc-collapse', 250));
  };
  useLayoutEffect(() => {
    const wrap = fold.current;
    const scroller = scrollerOf(root.current);
    if (folded || !opening.current || !wrap || !scroller) return;
    opening.current = false;
    wrap.style.maxHeight = '0px';
    void wrap.offsetHeight;
    wrap.dataset.fold = 'opening';
    wrap.style.maxHeight = `${scroller.clientHeight}px`;
    const t = setTimeout(() => {
      wrap.style.maxHeight = '';
      delete wrap.dataset.fold;
    }, durationVar('--acc-expand', 250));
    return () => clearTimeout(t);
  }, [folded]);

  const scrollPast = (where: 'before' | 'after') => {
    const scroller = scrollerOf(root.current);
    const el = root.current;
    if (!scroller || !el) return;
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    const prev = el.previousElementSibling;
    const top =
      where === 'before'
        ? prev
          ? offsetIn(scroller, prev) + prev.getBoundingClientRect().height - scroller.clientHeight + 72
          : 0
        : offsetIn(scroller, el) + el.getBoundingClientRect().height - Math.min(scroller.clientHeight * 0.35, 240);
    if (Math.abs(top - scroller.scrollTop) > scroller.clientHeight * 1.5 && !reducedMotion()) {
      arrive(scroller.querySelector('.message-list') ?? scroller);
      scroller.scrollTop = top;
    } else scroller.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <div ref={root} className={`msg doc ${props.flash ? 'flash' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
      <DocHeader
        headRef={head}
        rootRef={root}
        bodyRef={body}
        meta={meta}
        sharedAt={m.createdAt}
        parsed={parsed}
        doc={doc}
        threads={threads}
        folded={folded}
        contentsOpen={contentsOpen}
        onContents={() => contents?.toggle(m.id)}
        onAt={contentsOpen ? contents!.setAt : undefined}
        onFold={toggleFold}
        onPast={scrollPast}
        onOpenThread={(t) => onOpenThread?.(m, t.blockIndex, t.blockEnd)}
      />
      {!folded && (
        <div ref={fold} className="doc-fold">
          <div ref={body} className="doc-body">
            {parsed &&
              doc?.chunks.map((c, k) => (
                <DocChunk key={k} k={k} chunk={c} parsed={parsed} rendered={rendered(k)} height={rendered(k) ? 0 : heightOf(k)} renderBlock={renderBlock} />
              ))}
          </div>
          <div className="doc-end">
            <span className="promoted-rule" />
            <span>
              End of {meta.name} ·{' '}
              <button className="link" onClick={() => doc && jumpTo(0, 'start')}>
                back to the top
              </button>
            </span>
            <span className="promoted-rule" />
          </div>
        </div>
      )}
    </div>
  );
});

/** Folded documents stay folded for this viewer. */
function useFolded(id: string): [boolean, (v: boolean) => void] {
  const key = `doc-folded:${id}`;
  const [folded, set] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const update = useCallback(
    (v: boolean) => {
      set(v);
      try {
        if (v) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
      } catch {
        // storage unavailable: folded for this visit only
      }
    },
    [key],
  );
  return [folded, update];
}

const DocChunk = memo(function DocChunk({
  k,
  chunk,
  parsed,
  rendered,
  height,
  renderBlock,
}: {
  k: number;
  chunk: Chunk;
  parsed: Parsed;
  rendered: boolean;
  height: number;
  renderBlock: (b: Block, content: ReactNode) => ReactNode;
}) {
  const lead = parsed.blocks[chunk.from]?.node[0];
  if (!rendered) return <section className="doc-chunk is-placeholder" data-chunk={k} data-lead={lead} style={{ height }} aria-hidden />;
  return (
    <section className="doc-chunk" data-chunk={k} data-lead={lead}>
      <MarkdownBlocks parsed={{ tree: parsed.tree, blocks: parsed.blocks.slice(chunk.from, chunk.to) }} total={parsed.blocks.length} renderBlock={renderBlock} className="md-doc" />
    </section>
  );
});

/** A far jump lands with a quick cross-blur instead of a long scroll (transitions.dev page slide values). */
function arrive(el: HTMLElement) {
  el.classList.remove('doc-arrive');
  void el.offsetWidth;
  el.classList.add('doc-arrive');
  setTimeout(() => el.classList.remove('doc-arrive'), durationVar('--page-slide-dur', 250) + 50);
}

/** For a few frames after a jump, puts the target back where it landed if chunks above it resized. */
function settle(scroller: HTMLElement, target: () => number): () => void {
  let frames = 0;
  let raf = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
  const tick = () => {
    if (stopped) return;
    const top = target();
    if (Math.abs(top - scroller.scrollTop) > 1) scroller.scrollTop = top;
    if (++frames < 12) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  scroller.addEventListener('wheel', stop, { once: true, passive: true });
  scroller.addEventListener('touchstart', stop, { once: true, passive: true });
  return () => {
    stop();
    scroller.removeEventListener('wheel', stop);
    scroller.removeEventListener('touchstart', stop);
  };
}

interface HeaderProps {
  headRef: RefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  meta: DocMeta;
  sharedAt: number;
  parsed: Parsed | null;
  doc: Doc | null;
  threads: ChildThread[];
  folded: boolean;
  contentsOpen: boolean;
  onContents: () => void;
  /** Told the heading at the reading line while the contents pane follows this document. */
  onAt?: (at: number) => void;
  onFold: () => void;
  onPast: (where: 'before' | 'after') => void;
  onOpenThread: (t: ChildThread) => void;
}

/** Sticks to the top while the document is on screen: title, current section, progress, and its menus. */
function DocHeader({ headRef, rootRef, bodyRef, meta, sharedAt, parsed, doc, threads, folded, contentsOpen, onContents, onAt, onFold, onPast, onOpenThread }: HeaderProps) {
  const [stuck, setStuck] = useState(false);
  // The jumps around the document only help when it is longer than the screen.
  const [long, setLong] = useState(false);
  const [first, setFirst] = useState(true);
  // The heading of the block at the reading line, and the one above it.
  const [at, setAt] = useState(-1);
  const [menu, setMenu] = useState<'threads' | null>(null);
  const bar = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const rootEl = rootRef.current;
    const scroller = scrollerOf(rootEl);
    if (!rootEl || !scroller || !doc) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const s = scroller.getBoundingClientRect();
      const r = rootEl.getBoundingClientRect();
      const headH = headRef.current?.offsetHeight ?? 0;
      setStuck(r.top < s.top - 1 && r.bottom > s.top + headH + 1);
      setLong(r.height > s.height * 1.5);
      setFirst(!rootEl.previousElementSibling);
      const p = Math.min(1, Math.max(0, (s.top - r.top) / Math.max(1, r.height - s.height)));
      if (bar.current) bar.current.style.transform = `scaleX(${p})`;
      // The section of the block at the reading line, just under the header.
      const line = s.top + headH + 24;
      let at = -1;
      for (const b of Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [])) {
        if (b.getBoundingClientRect().top > line) break;
        at = Number(b.dataset.block);
      }
      setAt(at < 0 ? -1 : (sectionAt(doc.headings, at)?.index ?? -1));
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    scroller.addEventListener('scroll', on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(rootEl);
    update();
    return () => {
      scroller.removeEventListener('scroll', on);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [doc, folded]);

  const words = meta.words.toLocaleString();
  const trail = doc && at >= 0 ? trailAt(doc.headings, at) : '';
  const sub = stuck && trail ? trail : `shared ${time(sharedAt)} · ${words} words · ${readingTime(meta.words)}${threads.length ? ` · ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}` : ''}`;
  useEffect(() => {
    onAt?.(at);
  }, [at, onAt]);
  const menuView = useDropdown(menu);
  useMenuDismiss(!!menu, headRef, () => setMenu(null));
  const where = (index: number) => (doc ? doc.offsets[index] / doc.chars : 0);

  return (
    <div ref={headRef} className="doc-head" data-stuck={stuck && !folded}>
      <span className="doc-icon" aria-hidden>
        <FileMd size={18} />
      </span>
      <div className="doc-title">
        <span className="doc-name">{meta.name}</span>
        <SwapText className="doc-sub" text={sub} />
      </div>
      <span className="doc-actions">
        {!folded && doc && doc.headings.length > 1 && (
          <button className={`doc-btn ${contentsOpen ? 'on' : ''}`} onClick={onContents} data-tooltip={contentsOpen ? 'Close contents' : 'Contents'} aria-label="Contents" aria-expanded={contentsOpen}>
            <ListDashes size={16} />
          </button>
        )}
        {threads.length > 0 && (
          <button
            className={`doc-btn doc-threads-btn ${menu === 'threads' ? 'on' : ''}`}
            onClick={() => setMenu(menu === 'threads' ? null : 'threads')}
            data-tooltip="Threads on this document"
            aria-label="Threads on this document"
            aria-expanded={menu === 'threads'}
          >
            {ICONS.thread}
            <PopNumber value={threads.length} />
          </button>
        )}
        {long && !first && (
          <button className="doc-btn" onClick={() => onPast('before')} data-tooltip="Back to the conversation before" aria-label="Back to the conversation before">
            <ArrowLineUp size={16} />
          </button>
        )}
        {long && (
          <button className="doc-btn" onClick={() => onPast('after')} data-tooltip="Skip past the document" aria-label="Skip past the document">
            <ArrowLineDown size={16} />
          </button>
        )}
        <button className="doc-btn" onClick={onFold} data-tooltip={folded ? 'Unfold the document' : 'Fold the document'} aria-label={folded ? 'Unfold the document' : 'Fold the document'} aria-expanded={!folded}>
          {folded ? <ArrowsOutLineVertical size={16} /> : <ArrowsInLineVertical size={16} />}
        </button>
      </span>
      {!folded && (
        <span className="doc-track" aria-hidden={!stuck}>
          <span ref={bar} className="doc-progress" />
          {threads.map((t) => (
            <button
              key={t.id}
              className="doc-tick"
              style={{ left: `${where(t.blockIndex) * 100}%` }}
              tabIndex={stuck ? 0 : -1}
              data-tooltip={`${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'} · ${parsed ? excerpt(parsed.blocks, t.blockIndex, 60) : ''}`}
              aria-label="Open thread"
              onClick={() => onOpenThread(t)}
            />
          ))}
        </span>
      )}
      {menuView.shown && (
        <div className={`doc-menu ${menuView.className}`} data-origin="top-right" role="menu">
          <div className="doc-menu-title">
            {threads.length} {threads.length === 1 ? 'thread' : 'threads'} on this document
          </div>
          {threads.map((t) => {
            const sec = doc ? sectionAt(doc.headings, t.blockIndex) : null;
            return (
              <button
                key={t.id}
                className="dd-item doc-thread-item"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  onOpenThread(t);
                }}
              >
                <span className="dd-title">{parsed ? excerpt(parsed.blocks, t.blockIndex) : 'Passage'}</span>
                <span className="dd-sub">
                  {sec && sec.index !== t.blockIndex ? `${sec.text} · ` : ''}
                  {t.channel ? `became #${t.channel.name}` : `${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'} · ${relTime(t.lastActivity)}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Closes a header menu on Esc (before the thread panel sees it) or a press outside the header. */
function useMenuDismiss(open: boolean, inside: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    const down = (e: PointerEvent) => {
      if (!inside.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', down, true);
    };
  }, [open]);
}
