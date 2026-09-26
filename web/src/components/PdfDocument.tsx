import { ArrowSquareOut, MagnifyingGlassMinus, MagnifyingGlassPlus, WarningCircle } from '@phosphor-icons/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PdfLayout, PdfPageLayout } from '../../../shared/pdf.ts';
import type { ChildThread } from '../lib/api.ts';
import { docMeta, trailAt } from '../lib/document.ts';
import { acquirePdf, cachedBitmap, keepBitmap, pageText, pdfBlocksOf, pdfjs, pdfPage, usePdfLayout, type PdfDocMeta } from '../lib/pdf.ts';
import { navigate } from '../lib/router.ts';
import { narrowScreen } from '../lib/useSidebar.ts';
import { durationVar } from '../lib/usePresence.ts';
import type { Parsed } from '../markdown/parse.ts';
import { useContents } from './DocContents.tsx';
import { arrive, DocHeader, offsetIn, reducedMotion, SCROLL_INTENT, scrollerOf, scrollPastDoc, useFolded, type Doc } from './DocumentMessage.tsx';
import { ICONS } from './icons.tsx';
import { relTime, type BlockRange, type MessageProps } from './Message.tsx';
import '../styles/pdf.css';

/** A page is never drawn wider than this (the reading column's width at "fit"). */
const FIT_MAX = 880;
const GAP = 16;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
/** Pixels per PDF point at 100 %: PDF viewers call 1 pt = 1/72 in, 96 CSS px per inch, actual size. */
const ACTUAL = 96 / 72;
/** A page's bitmap is capped at this many pixels (zoomed in on a high-DPI screen); CSS stretches the rest. */
const MAX_PIXELS = 16_000_000;

const within = (r: BlockRange | null | undefined, i: number) => !!r && r.start <= i && i <= r.end;
const turned = (p: PdfPageLayout) => p.r === 90 || p.r === 270;
/** The page as shown: its box after rotation, in points. */
const shownSize = (p: PdfPageLayout) => (turned(p) ? { w: p.h, h: p.w } : { w: p.w, h: p.h });

interface Jump {
  index: number;
  how: 'start' | 'center';
  smooth: boolean;
  seq: number;
}

/**
 * A shared PDF in the timeline, read the way a shared Markdown document is (DocumentMessage): the same
 * sticky header, contents, threads menu, fold and jumps. Its pages are drawn by pdf.js, with a text layer
 * to select from; only the pages near the viewport are drawn, the rest are paper of their exact size.
 * Paragraphs come from the layout the server made at upload, so a selection maps to the same blocks
 * the server quotes, and thread marks sit on the page at any zoom.
 */
export const PdfDocumentMessage = memo(function PdfDocumentMessage(props: MessageProps) {
  const { m, childThreads, activeRange, pendingRange, onOpenThread, onExtendPassage, allowThreads } = props;
  const meta = docMeta(m) as PdfDocMeta;
  const layout = usePdfLayout(meta);
  const blocks = pdfBlocksOf(m.id, m.content);
  // The header's menus quote passages by their text, as they do a Markdown document's blocks.
  const parsed = useMemo<Parsed>(() => ({ tree: [], blocks: blocks.map((b, index) => ({ index, node: ['p', {}, b.text] })) }), [blocks]);
  const doc = useMemo<Doc | null>(() => {
    if (!layout) return null;
    // Where a passage sits, as a share of the document's height: for the header's thread ticks.
    const offsets: number[] = [];
    let y = 0;
    for (const p of layout.pages) {
      for (const para of p.paras) offsets.push(y + para[3]);
      y += shownSize(p).h + GAP;
    }
    return { chunks: [], headings: layout.headings, offsets, chars: Math.max(1, y) };
  }, [layout]);
  const threads = useMemo(
    () => (childThreads ?? []).filter((t) => t.parentMessageId === m.id).sort((a, b) => a.blockIndex - b.blockIndex || a.blockEnd - b.blockEnd),
    [childThreads, m.id],
  );
  const canThread = !!allowThreads && m.status === 'done' && !!onOpenThread;
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pagesEl = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useFolded(m.id);
  const fold = useRef<HTMLDivElement>(null);
  const contents = useContents();
  const contentsOpen = contents?.openId === m.id;

  // ---- the PDF itself: parsed once, shared with any other view of it, only while unfolded ----
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (folded) return;
    const held = acquirePdf(meta.file);
    let live = true;
    held.doc.then(
      (d) => live && setPdf(d),
      (e) => live && setFailed(String(e?.message ?? e)),
    );
    return () => {
      live = false;
      held.release();
    };
  }, [meta.file, folded]);

  // ---- size: fit the column, times the reader's zoom ----
  const [fit, setFit] = useState(0);
  const fitRef = useRef(0);
  const [zoom, setZoom] = useZoom(m.id);
  const widest = useMemo(() => (layout ? Math.max(...layout.pages.map((p) => shownSize(p).w)) : 612), [layout]);
  const scale = fit ? (Math.min(fit, FIT_MAX) / widest) * zoom : 0;

  // A new size keeps a point of the page where it was on screen: the one under the pointer when
  // zooming by pinch, else the middle of the screen (a zoom button, a resize: the thread panel opening).
  const anchor = useRef<{ page: number; fx: number; fy: number; vx: number; vy: number } | null>(null);
  const hold = useCallback((at?: { x?: number; y: number }) => {
    const scroller = scrollerOf(root.current);
    const box = pagesEl.current;
    if (!scroller || !box || anchor.current) return;
    const s = scroller.getBoundingClientRect();
    const vx = at?.x ?? s.left + s.width / 2;
    const vy = at?.y ?? s.top + s.height / 2;
    const pages = Array.from(box.children) as HTMLElement[];
    const i = pageAtY(pages, vy);
    if (i < 0) return;
    const r = pages[i].getBoundingClientRect();
    anchor.current = { page: i, fx: (vx - r.left) / r.width, fy: (vy - r.top) / r.height, vx, vy };
  }, []);
  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      hold(at);
      setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
    },
    [setZoom, hold],
  );
  useLayoutEffect(() => {
    const el = pagesEl.current;
    if (!el) return;
    const measure = (first = false) => {
      const cs = getComputedStyle(el);
      const w = Math.max(120, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      if (!first && fitRef.current && Math.abs(fitRef.current - w) > 1) {
        const s = scrollerOf(el)?.getBoundingClientRect();
        if (s) hold({ x: s.left, y: s.top + s.height / 2 });
      }
      fitRef.current = w;
      setFit(w);
    };
    measure(true);
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!layout, folded]);
  useLayoutEffect(() => {
    const a = anchor.current;
    const scroller = scrollerOf(root.current);
    const box = pagesEl.current;
    anchor.current = null;
    // Just jumped to a passage (a thread opening narrows the column as it slides in): stay on it.
    if (focus.current && scroller) {
      const top = targetTop(focus.current.index, focus.current.how);
      if (top !== null) scroller.scrollTop = top;
      return;
    }
    if (!a || !scroller || !box) return;
    const page = box.children[a.page] as HTMLElement | undefined;
    if (!page) return;
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    const r = page.getBoundingClientRect();
    scroller.scrollTop += r.top + a.fy * r.height - a.vy;
    box.scrollLeft += r.left + a.fx * r.width - a.vx;
  }, [scale]);

  // Pinch on a trackpad, or ctrl/⌘ + wheel, zooms the PDF rather than the whole app.
  useEffect(() => {
    const el = pagesEl.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomTo(zoomRef.current * Math.exp(-delta * 0.01), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [!!layout, folded, zoomTo]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // ---- windowing: which pages are drawn ----
  const n = layout?.pages.length ?? 0;
  const [inView, setInView] = useState<Set<number> | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const jumpPage = jump && layout ? pageOfBlock(layout, jump.index) : -9;
  const drawn = (k: number) => k === jumpPage || (inView ? inView.has(k) : k < 2);
  useEffect(() => {
    const el = pagesEl.current;
    if (!el || !layout) return;
    const io = new IntersectionObserver(
      (entries) =>
        setInView((prev) => {
          const next = new Set(prev ?? [0, 1]);
          for (const e of entries) {
            const k = Number((e.target as HTMLElement).dataset.page) - 1;
            if (e.isIntersecting) next.add(k);
            else next.delete(k);
          }
          return prev && prev.size === next.size && [...next].every((k) => prev.has(k)) ? prev : next;
        }),
      // A screen above and below: pages are drawn before they scroll in.
      { root: scrollerOf(el), rootMargin: '100% 0px' },
    );
    for (const c of Array.from(el.children)) io.observe(c);
    return () => io.disconnect();
  }, [layout, folded]);

  // ---- where things are: blocks by position, positions by block ----
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** Top of a block in the scroller's content, or null while its page is not laid out. */
  const blockTop = (index: number) => {
    const l = layoutRef.current;
    const scroller = scrollerOf(root.current);
    if (!l || !scroller) return null;
    const k = pageOfBlock(l, index);
    const page = pagesEl.current?.children[k] as HTMLElement | undefined;
    const para = l.pages[k]?.paras[index - l.pages[k].first];
    if (!page || !para) return null;
    return { top: offsetIn(scroller, page) + para[3] * scaleRef.current, height: (para[5] - para[3]) * scaleRef.current, page };
  };
  // Stable for the header, which reads it on every scroll frame.
  const linePage = useRef(0);
  const blockAt = useCallback((line: number) => {
    const l = layoutRef.current;
    const pages = Array.from(pagesEl.current?.children ?? []) as HTMLElement[];
    if (!l || !pages.length) return -1;
    let k = pageAtY(pages, line);
    if (k < 0) k = pages[0].getBoundingClientRect().top > line ? 0 : pages.length - 1;
    linePage.current = k;
    const r = pages[k].getBoundingClientRect();
    const p = l.pages[k];
    const y = (line - r.top) / scaleRef.current;
    let j = -1;
    for (let i = 0; i < p.paras.length && p.paras[i][3] <= y; i++) j = i;
    if (j >= 0) return p.first + j;
    // In the page's top margin: the reader is on this page, at its first passage.
    if (k === 0 && r.top > line) return -1;
    return p.paras.length ? p.first : p.first - 1;
  }, []);
  const whereAt = useCallback(
    (block: number) => {
      const l = layoutRef.current;
      if (!l) return '';
      const page = `Page ${linePage.current + 1} of ${l.pages.length}`;
      const trail = l.contents === 'pages' ? '' : trailAt(l.headings, block);
      return trail ? `${page} · ${trail}` : page;
    },
    [blocks],
  );

  // ---- jumps: draw the target's page, then scroll it into place ----
  const [target, setTarget] = useState<{ index: number; seq: number } | null>(null);
  const jumpTo = useCallback((index: number, how: Jump['how'] = 'center', smooth = true) => setJump({ index, how, smooth, seq: performance.now() }), []);
  /** Where the scroller goes to show a block. */
  const targetTop = (index: number, how: Jump['how']) => {
    const scroller = scrollerOf(root.current);
    const at = blockTop(index);
    if (!scroller || !at) return null;
    const headH = head.current?.offsetHeight ?? 0;
    // A page's first passage shows its page from the top.
    const lead = layoutRef.current?.pages.find((p) => p.first === index && p.paras.length);
    return how === 'start' ? (lead ? offsetIn(scroller, at.page) : at.top) - headH - 16 : at.top - Math.max(headH + 16, (scroller.clientHeight - at.height) / 2);
  };
  // The passage last jumped to, until the reader scrolls on their own.
  const focus = useRef<{ index: number; how: Jump['how'] } | null>(null);
  useEffect(() => {
    const scroller = scrollerOf(root.current);
    if (!scroller) return;
    const off = () => void (focus.current = null);
    const opts = { passive: true } as const;
    for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) scroller.addEventListener(ev, off, opts);
    return () => {
      for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) scroller.removeEventListener(ev, off);
    };
  }, [folded]);
  useLayoutEffect(() => {
    const scroller = scrollerOf(root.current);
    const top = jump && targetTop(jump.index, jump.how);
    if (!jump || !scroller || top === null) return;
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    focus.current = { index: jump.index, how: jump.how };
    const far = Math.abs(top - scroller.scrollTop) > scroller.clientHeight * 1.5;
    setTarget({ index: jump.index, seq: jump.seq });
    if (jump.smooth && !far && !reducedMotion()) return void scroller.scrollTo({ top, behavior: 'smooth' });
    if (jump.smooth && !reducedMotion()) arrive(body.current!);
    scroller.scrollTop = top;
  }, [jump]);

  useEffect(() => {
    if (contentsOpen && doc) contents!.publish({ id: m.id, name: meta.name, pdf: true, headings: doc.headings, threads, jump: (index) => jumpTo(index, 'start') });
  }, [contentsOpen, doc, threads, meta.name]);

  // A thread opened elsewhere (the panel's previous / next, a link): bring its passage into view.
  useEffect(() => {
    if (!activeRange || !layout || folded || !scale) return;
    const scroller = scrollerOf(root.current);
    const at = blockTop(activeRange.start);
    if (scroller && at) {
      const s = scroller.getBoundingClientRect();
      const top = at.top - scroller.scrollTop + s.top;
      if (top + at.height > s.top + (head.current?.offsetHeight ?? 0) && top < s.bottom) return;
    }
    jumpTo(activeRange.start);
  }, [activeRange?.start, layout, folded, !!scale]);

  // ---- fold: the document shrinks to its header, and opens again (as DocumentMessage's) ----
  const opening = useRef(false);
  const toggleFold = () => {
    if (!folded && contentsOpen) contents!.close();
    const scroller = scrollerOf(root.current);
    const wrap = fold.current;
    if (folded || !scroller || !wrap || reducedMotion()) {
      opening.current = folded && !reducedMotion();
      return setFolded(!folded);
    }
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

  const openThread = useCallback((t: ChildThread) => onOpenThread?.(m, t.blockIndex, t.blockEnd), [m, onOpenThread]);
  const pct = Math.round((scale / ACTUAL) * 100);
  const tools = (
    <>
      {layout && scale > 0 && !narrowScreen() && (
        <span className="pdf-zoom" role="group" aria-label="Zoom">
          <button className="doc-btn" onClick={() => zoomTo(zoom / 1.25)} disabled={zoom <= ZOOM_MIN} data-tooltip="Zoom out · or pinch" aria-label="Zoom out">
            <MagnifyingGlassMinus size={16} />
          </button>
          <button className={`doc-btn pdf-zoom-pct ${zoom === 1 ? '' : 'on'}`} onClick={() => zoomTo(1)} data-tooltip={zoom === 1 ? 'Fits the width' : 'Fit the width'} aria-label="Fit the width">
            {pct}%
          </button>
          <button className="doc-btn" onClick={() => zoomTo(zoom * 1.25)} disabled={zoom >= ZOOM_MAX} data-tooltip="Zoom in · or pinch" aria-label="Zoom in">
            <MagnifyingGlassPlus size={16} />
          </button>
        </span>
      )}
      <a className="doc-btn" href={`/api/files/${meta.file}?name=${encodeURIComponent(meta.name)}`} target="_blank" rel="noreferrer" data-tooltip="Open the PDF in a new tab" aria-label="Open the PDF in a new tab">
        <ArrowSquareOut size={16} />
      </a>
    </>
  );

  return (
    <div ref={root} className={`msg doc doc-pdf ${props.flash ? 'flash' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
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
        onPast={(where) => scrollPastDoc(root.current, where)}
        onOpenThread={openThread}
        docId={m.id}
        // A PDF is read-only: no pencil, one version, nothing to preview.
        editing={false}
        preview={null}
        editLabel=""
        onVersion={() => {}}
        blockAt={blockAt}
        whereAt={whereAt}
        tools={tools}
      />
      {!folded && (
        <div ref={fold} className="doc-fold">
          <div ref={body} className="doc-body pdf-body">
            {meta.scanned && (
              <div className="pdf-note">
                <WarningCircle size={16} aria-hidden />
                <span>This PDF looks scanned: its pages have little or no text, so passages cannot be picked for threads. Agents are pointed at the file itself.</span>
              </div>
            )}
            {failed && (
              <div className="pdf-note is-error">
                <WarningCircle size={16} aria-hidden />
                <span>The PDF could not be shown ({failed}). Agents still read its text.</span>
              </div>
            )}
            <div ref={pagesEl} className="pdf-pages" style={{ '--pdf-gap': `${GAP}px` } as CSSProperties}>
              {layout &&
                scale > 0 &&
                layout.pages.map((p, k) => (
                  <PdfPage
                    key={k}
                    n={k + 1}
                    file={meta.file}
                    page={p}
                    scale={scale}
                    pdf={drawn(k) ? pdf : null}
                    threads={threads}
                    activeRange={activeRange ?? null}
                    pendingRange={pendingRange ?? null}
                    target={target && target.index >= p.first && target.index < p.first + p.paras.length ? target : null}
                    canThread={canThread}
                    onOpen={(start, end) => onOpenThread?.(m, start, end)}
                    onExtend={onExtendPassage ? (i, at) => onExtendPassage(m, i, at) : undefined}
                  />
                ))}
              {!layout && <div className="pdf-page is-loading" style={{ width: Math.min(fit || 600, FIT_MAX), aspectRatio: '612 / 792' }} aria-hidden />}
            </div>
          </div>
          <div className="doc-end">
            <span className="promoted-rule" />
            <span>
              End of {meta.name} · {n.toLocaleString()} {n === 1 ? 'page' : 'pages'} ·{' '}
              <button className="link" onClick={() => layout && jumpTo(0, 'start')}>
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

/** The reader's zoom for this PDF, relative to fitting the width; 1 = fit. Kept per viewer. */
function useZoom(id: string): [number, (z: number) => void] {
  const key = `pdf-zoom:${id}`;
  const [zoom, set] = useState(() => {
    try {
      const z = Number(localStorage.getItem(key));
      return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
    } catch {
      return 1;
    }
  });
  const update = useCallback(
    (z: number) => {
      const v = Math.abs(z - 1) < 0.02 ? 1 : Math.round(z * 1000) / 1000;
      set(v);
      try {
        if (v === 1) localStorage.removeItem(key);
        else localStorage.setItem(key, String(v));
      } catch {
        // storage unavailable: this visit only
      }
    },
    [key],
  );
  return [zoom, update];
}

/** The page (0-based) holding a block: the last page starting at or before it that has paragraphs. */
function pageOfBlock(layout: PdfLayout, index: number): number {
  let lo = 0;
  let hi = layout.pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.pages[mid].first <= index) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && !layout.pages[lo].paras.length) lo--;
  return lo;
}

/** The page element under a viewport y (binary search over the pages, top to bottom), or -1. */
function pageAtY(pages: HTMLElement[], y: number): number {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = pages[mid].getBoundingClientRect();
    if (y < r.top - GAP) hi = mid - 1;
    else if (y > r.bottom) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Raw (unrotated) page coordinates, in points, of a point on the page as shown. */
function toRaw(p: PdfPageLayout, rect: DOMRect, x: number, y: number): [number, number] {
  const sx = ((x - rect.left) / rect.width) * shownSize(p).w;
  const sy = ((y - rect.top) / rect.height) * shownSize(p).h;
  if (p.r === 90) return [sy, p.h - sx];
  if (p.r === 180) return [p.w - sx, p.h - sy];
  if (p.r === 270) return [p.w - sy, sx];
  return [sx, sy];
}

interface PageProps {
  n: number;
  file: string;
  page: PdfPageLayout;
  scale: number;
  /** Set while the page is near the screen: then it is drawn. */
  pdf: PDFDocumentProxy | null;
  threads: ChildThread[];
  activeRange: BlockRange | null;
  pendingRange: BlockRange | null;
  target: { index: number; seq: number } | null;
  canThread: boolean;
  onOpen: (start: number, end?: number) => void;
  onExtend?: (index: number, at: DOMRect) => void;
}

const PdfPage = memo(function PdfPage({ n, file, page, scale, pdf, threads, activeRange, pendingRange, target, canThread, onOpen, onExtend }: PageProps) {
  const size = shownSize(page);
  const cssW = Math.round(size.w * scale);
  const cssH = Math.round(size.h * scale);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const [hover, setHover] = useState(-1);
  const first = page.first;
  const count = page.paras.length;
  const mine = useMemo(() => threads.filter((t) => t.blockIndex < first + count && t.blockEnd >= first), [threads, first, count]);
  const covering = (i: number) => mine.filter((t) => t.blockIndex <= i && i <= t.blockEnd);

  // What the pointer is over: a paragraph (for the reply button and a click on a thread's passage).
  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.pdf-gutter, .pdf-badge')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const [x, y] = toRaw(page, rect, e.clientX, e.clientY);
    const pad = 4;
    // The left margin counts as the paragraph beside it, so the pointer can reach the reply button.
    const j = page.paras.findIndex((q) => y >= q[3] - pad && y <= q[5] + pad && x <= q[4] + 3 * pad);
    if (j !== hover) setHover(j);
  };
  const onClick = (e: ReactMouseEvent) => {
    if (hover < 0 || window.getSelection()?.toString() || (e.target as HTMLElement).closest('a, button')) return;
    const on = covering(first + hover);
    const tightest = on.reduce<ChildThread | undefined>((a, t) => (!a || t.blockEnd - t.blockIndex < a.blockEnd - a.blockIndex ? t : a), undefined);
    if (tightest) onOpen(tightest.blockIndex, tightest.blockEnd);
  };

  const hoverIndex = hover >= 0 ? first + hover : -1;
  const hoverThread = hoverIndex >= 0 && covering(hoverIndex).length > 0;
  // One rail per thread (and for the pending pick) down its paragraphs on this page.
  const rails: { key: string; kind: string; y0: number; y1: number; x0: number }[] = [];
  const railOf = (key: string, kind: string, a: number, z: number) => {
    const lo = Math.max(a, first) - first;
    const hi = Math.min(z, first + count - 1) - first;
    if (hi < lo) return;
    const ps = page.paras.slice(lo, hi + 1);
    rails.push({ key, kind, x0: Math.min(...ps.map((q) => q[2])), y0: Math.min(...ps.map((q) => q[3])), y1: Math.max(...ps.map((q) => q[5])) });
  };
  for (const t of mine) {
    const on = within(activeRange, t.blockIndex) || (hoverIndex >= t.blockIndex && hoverIndex <= t.blockEnd);
    railOf(t.id, on ? 'is-on' : '', t.blockIndex, t.blockEnd);
  }
  if (pendingRange) railOf('pending', 'is-pending', pendingRange.start, pendingRange.end);

  return (
    <section
      className={`pdf-page ${hoverThread ? 'over-thread' : ''}`}
      data-page={n}
      style={{ width: cssW, height: cssH, '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(-1)}
      onClick={onClick}
      aria-label={`Page ${n}`}
    >
      {pdf ? <PageCanvas pdf={pdf} file={file} n={n} cssW={cssW} cssH={cssH} /> : null}
      <div className="pdf-raw" data-main-rotation={page.r} style={{ width: page.w * scale, height: page.h * scale }}>
        <div className="pdf-marks" aria-hidden>
          {page.paras.map((q, j) => {
            const i = first + j;
            const cls = [within(activeRange, i) && 'is-active', within(pendingRange, i) && 'is-pending', j === hover && canThread && 'is-hover'].filter(Boolean);
            const flash = target?.index === i;
            if (!cls.length && !flash) return null;
            return (
              <span
                key={flash ? `${j}:${target!.seq}` : j}
                className={`pdf-mark ${cls.join(' ')} ${flash ? 'doc-target' : ''}`}
                style={{ left: pct(q[2] - 3, page.w), top: pct(q[3] - 2, page.h), width: pct(q[4] - q[2] + 6, page.w), height: pct(q[5] - q[3] + 4, page.h) }}
              />
            );
          })}
          {rails.map((r) => (
            <span key={r.key} className={`pdf-rail ${r.kind}`} style={{ left: `calc(${pct(r.x0, page.w)} - 9px)`, top: pct(r.y0, page.h), height: pct(r.y1 - r.y0, page.h) }} />
          ))}
        </div>
        {pdf ? <TextLayer pdf={pdf} file={file} n={n} page={page} /> : null}
        {canThread && hover >= 0 && (
          <button
            className="pdf-gutter"
            style={{ top: pct(page.paras[hover][3], page.h) }}
            data-tooltip="Reply in thread · ⇧-click another to span paragraphs"
            aria-label="Reply in thread"
            onMouseDown={(e) => {
              if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (e.shiftKey && onExtend) onExtend(first + hover, e.currentTarget.getBoundingClientRect());
              else onOpen(first + hover);
            }}
          >
            {ICONS.thread}
          </button>
        )}
        {mine
          .filter((t) => t.blockEnd >= first && t.blockEnd < first + count)
          .map((t) => {
            const q = page.paras[t.blockEnd - first];
            const right = q[4] / page.w > 0.8;
            const span = t.blockEnd > t.blockIndex ? ` · ${t.blockEnd - t.blockIndex + 1} paragraphs` : '';
            return (
              <button
                key={t.id}
                className={`pdf-badge ${t.channel ? 'to-channel' : ''} ${right ? 'at-edge' : ''}`}
                style={{ top: `calc(${pct(q[5], page.h)} - 20px)`, ...(right ? {} : { left: `calc(${pct(q[4], page.w)} + 8px)` }) }}
                data-tooltip={t.channel ? `This thread became #${t.channel.name}` : `${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}${span} · ${relTime(t.lastActivity)}`}
                aria-label={t.channel ? `Open #${t.channel.name}` : `Open thread, ${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (t.channel) navigate({ view: 'conversation', conversationId: t.channel.id });
                  else onOpen(t.blockIndex, t.blockEnd);
                }}
              >
                <span className="pdf-badge-icon">{t.channel ? ICONS.hash : ICONS.reply}</span>
                <span className="pdf-badge-count">{t.channel ? t.channel.name : t.replyCount}</span>
              </button>
            );
          })}
      </div>
    </section>
  );
});

/**
 * The page's drawing. A drawing made earlier (at any size) shows at once, stretched; a sharp one for
 * the current size and screen follows, drawn off screen and swapped in, and kept for next time.
 */
function PageCanvas({ pdf, file, n, cssW, cssH }: { pdf: PDFDocumentProxy; file: string; n: number; cssW: number; cssH: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const show = (bmp: ImageBitmap) => {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      setReady(true);
    };
    const dpr = window.devicePixelRatio || 1;
    let want = Math.round(cssW * dpr);
    if (want * want * (cssH / cssW) > MAX_PIXELS) want = Math.floor(Math.sqrt(MAX_PIXELS * (cssW / cssH)));
    const hit = cachedBitmap(file, n);
    if (hit) show(hit.bmp);
    if (hit && Math.abs(hit.width - want) <= 2) return;
    let task: RenderTask | null = null;
    let live = true;
    // While zooming, the stretched drawing stands in; the sharp one waits for the zoom to settle.
    const timer = setTimeout(
      async () => {
        try {
          const page = await pdfPage(file, n);
          if (!live) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: want / base.width });
          const off = document.createElement('canvas');
          off.width = Math.round(viewport.width);
          off.height = Math.round(viewport.height);
          task = page.render({ canvas: off, canvasContext: off.getContext('2d', { alpha: false })!, viewport, background: '#ffffff' });
          await task.promise;
          if (!live) return;
          const bmp = await createImageBitmap(off);
          off.width = off.height = 0;
          if (!live) return bmp.close();
          keepBitmap(file, n, bmp);
          show(bmp);
        } catch {
          // cancelled, or the page failed to draw: the paper stays blank
        }
      },
      hit ? 160 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, file, n, cssW, cssH]);
  return <canvas ref={ref} className={`pdf-canvas ${ready ? 'is-ready' : ''}`} aria-hidden />;
}

/**
 * The selectable text, from pdf.js's text layer. Its spans are grouped by paragraph in wrappers that
 * carry the block index (display: contents, so the spans still sit where pdf.js put them): a
 * selection then maps to blocks exactly as it does in a Markdown document (ConversationView).
 */
function TextLayer({ pdf, file, n, page }: { pdf: PDFDocumentProxy; file: string; n: number; page: PdfPageLayout }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let layer: { cancel(): void } | null = null;
    Promise.all([pdfjs(), pdfPage(file, n), pageText(file, n)])
      .then(async ([lib, p, text]) => {
        if (!live) return;
        const tl = new lib.TextLayer({ textContentSource: text, container: el, viewport: p.getViewport({ scale: 1, rotation: 0 }) });
        layer = tl;
        await tl.render();
        if (!live) return;
        // The layer fills the page box; the size pdf.js sets would round to whole pixels.
        el.style.width = el.style.height = '';
        groupParagraphs(el, tl.textDivs, page);
        const end = document.createElement('div');
        end.className = 'endOfContent';
        el.append(end);
      })
      .catch(() => {});
    // pdf.js's selection trick: while selecting, a block covers the empty parts of the page, so a drag
    // through a margin does not select everything to the end.
    const down = () => el.classList.add('selecting');
    const up = () => el.classList.remove('selecting');
    el.addEventListener('mousedown', down);
    document.addEventListener('pointerup', up);
    window.addEventListener('blur', up);
    return () => {
      live = false;
      layer?.cancel();
      el.replaceChildren();
      el.removeEventListener('mousedown', down);
      document.removeEventListener('pointerup', up);
      window.removeEventListener('blur', up);
    };
  }, [pdf, file, n, page]);
  return <div ref={ref} className="textLayer" />;
}

/**
 * Moves each paragraph's spans into a `[data-block]` wrapper. The server numbered the page's text items
 * the way pdf.js's text layer does, so item k is span k; if the counts disagree (another pdf.js), each
 * span goes to the paragraph box it sits in instead.
 */
export function groupParagraphs(el: HTMLElement, divs: HTMLElement[], page: PdfPageLayout) {
  const owner = new Int32Array(divs.length).fill(-1);
  const exact = page.paras.every((q) => q[1] <= divs.length);
  if (exact) page.paras.forEach(([a, z], j) => owner.fill(j, a, z));
  else
    divs.forEach((d, k) => {
      const x = (parseFloat(d.style.left) / 100) * page.w;
      const y = (parseFloat(d.style.top) / 100) * page.h + 0.5 * (parseFloat(d.style.getPropertyValue('--font-height')) || 0);
      owner[k] = page.paras.findIndex((q) => x >= q[2] - 2 && x <= q[4] + 2 && y >= q[3] - 2 && y <= q[5] + 2);
    });
  const index = new Map(divs.map((d, k) => [d, k] as const));
  const wrappers = new Map<number, HTMLElement>();
  const frag = document.createDocumentFragment();
  let current: HTMLElement | null = null;
  for (const node of Array.from(el.childNodes)) {
    const k = index.get(node as HTMLElement);
    if (k !== undefined) {
      const j = owner[k];
      if (j < 0) current = null;
      else {
        current = wrappers.get(j) ?? null;
        if (!current) {
          current = document.createElement('div');
          current.className = 'pdf-para';
          current.dataset.block = String(page.first + j);
          wrappers.set(j, current);
          frag.append(current);
        }
      }
    }
    (current ?? frag).append(node);
  }
  el.append(frag);
}

