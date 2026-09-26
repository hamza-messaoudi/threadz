import { ArrowLineDown, ArrowLineUp, ArrowsInLineVertical, ArrowsOutLineVertical, ClockCounterClockwise, FileMd, FilePdf, ListDashes, PencilSimple } from '@phosphor-icons/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChildThread } from '../lib/api.ts';
import {
  chunkBlocks,
  chunkOf,
  docMeta,
  documentApi,
  docVersion,
  editorName,
  excerpt,
  REVEAL_EDIT,
  nodeText,
  outline,
  readingTime,
  sectionAt,
  sectionOf,
  sourceOf,
  trailAt,
  type Chunk,
  type DocMeta,
  type DocVersion,
  type Heading,
} from '../lib/document.ts';
import { navigate, parseRoute } from '../lib/router.ts';
import { agentColor } from '../lib/store.tsx';
import { isPdfDoc } from '../lib/pdf.ts';
import { useDropdown } from '../lib/useDropdown.ts';
import { durationVar } from '../lib/usePresence.ts';
import type { Block } from '../markdown/blocks.ts';
import { MarkdownBlocks, useParsed } from '../markdown/MessageMarkdown.tsx';
import type { Parsed } from '../markdown/parse.ts';
import { useContents } from './DocContents.tsx';
import { DocEditor, type Editing } from './DocEditor.tsx';
import { ICONS } from './icons.tsx';
import { relTime, useBlockRenderer, type MessageProps } from './Message.tsx';
import { PopNumber, SwapText } from './transitions.tsx';

/** A scroll the reader asked for (a jump, not a layout shift): ScrollArea stops following the bottom. */
export const SCROLL_INTENT = 'scrollintent';


/** Past this size the pencil opens the section being read, not the whole text: a 100-page textarea is no way to fix a typo. */
const WHOLE_EDIT_MAX = 40_000;

const NO_THREADS: ChildThread[] = [];

/** An older version on screen instead of the current one. */
interface Preview {
  version: number;
  content: string;
  info: DocVersion;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const scrollerOf = (el: Element | null) => el?.closest<HTMLElement>('.messages-scroll') ?? null;
/** An element's offset in the scroller's content. */
export const offsetIn = (scroller: HTMLElement, el: Element) => scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

export interface Doc {
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
  const version = docVersion(meta);
  const [preview, setPreview] = useState<Preview | null>(null);
  const parsed = useParsed(preview ? `${m.id}@${preview.version}` : m.id, preview ? preview.content : m.content, false);
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

  // ---- editing: the whole text, or a section, in place ----
  const [editing, setEditing] = useState<Editing | null>(null);
  const canEdit = !preview && !!parsed && !!doc;
  const startEdit = useCallback(
    (at: number | 'whole') => {
      if (!parsed || !doc) return;
      const whole = at === 'whole' || !parsed.lines || !doc.headings.length;
      let [from, to] = whole ? [0, parsed.blocks.length - 1] : sectionOf(doc.headings, parsed.blocks.length, at);
      // Nothing before the first heading: its section instead.
      if (to < from) [from, to] = sectionOf(doc.headings, parsed.blocks.length, doc.headings[0].index);
      const { text, at: offset } = whole ? { text: m.content, at: 0 } : sourceOf(m.content, parsed.lines!, from, to);
      const heading = doc.headings.find((h) => h.index === from);
      const label = whole ? meta.name : heading ? `“${heading.text}”` : `the opening of ${meta.name}`;
      setEditing({ from, to, whole, base: version, original: text, at: offset, draft: text, label });
    },
    [parsed, doc, m.content, version, meta.name],
  );
  // The section being edited, found again in a newer version by its first line (its heading).
  const relocate = useCallback(() => {
    if (!editing || editing.whole || !parsed?.lines || !doc) return null;
    const first = editing.original.split('\n')[0];
    const starts = firstLines(m.content, parsed.lines).flatMap((l, i) => (l === first ? [i] : []));
    if (starts.length !== 1) return null;
    const [from, to] = sectionOf(doc.headings, parsed.blocks.length, starts[0]);
    return to < from ? null : sourceOf(m.content, parsed.lines, from, to);
  }, [editing, parsed, doc, m.content]);
  const editor = editing && (
    <DocEditor
      key="editor"
      docId={m.id}
      name={meta.name}
      editing={editing}
      version={version}
      onDraft={(draft) => setEditing((e) => e && { ...e, draft })}
      onClose={() => setEditing(null)}
      onSaved={() => setEditing(null)}
      relocate={relocate}
    />
  );
  const headingPencil = useCallback(
    (b: Block) =>
      canEdit && parsed?.lines && /^h[1-3]$/.test(b.node[0]) ? (
        <button
          className="block-edit"
          onClick={(e) => {
            e.stopPropagation();
            startEdit(b.index);
          }}
          data-tooltip="Edit this section"
          aria-label={`Edit the section ${nodeText(b.node).trim()}`}
        >
          <PencilSimple size={14} />
        </button>
      ) : null,
    [canEdit, parsed, startEdit],
  );
  // An older version is only read: no threads on it, no pencils.
  const threadProps = preview ? { ...props, childThreads: NO_THREADS, allowThreads: false, activeRange: null, pendingRange: null, onOpenThread: undefined } : props;
  const baseRender = useBlockRenderer(threadProps, editing ? undefined : headingPencil);
  const renderBlock = useCallback(
    (b: Block, content: ReactNode) => {
      if (editing && !editing.whole && b.index >= editing.from && b.index <= editing.to) return b.index === editing.from ? editor : null;
      return baseRender(b, content);
    },
    [baseRender, editing, editor],
  );
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
  const editChunks = editing && !editing.whole && doc ? [chunkOf(doc.chunks, editing.from), chunkOf(doc.chunks, editing.to)] : null;
  const rendered = (k: number) =>
    Math.abs(k - jumpChunk) <= 1 || (!!editChunks && k >= editChunks[0] && k <= editChunks[1]) || (inView ? inView.has(k) : k < 2 || k >= n - 2);
  const heightOf = (k: number) => heights.current.get(k) ?? Math.round(doc!.chunks[k].chars * (measured.current.chars ? measured.current.px / measured.current.chars : 0.38));

  // Another version (an edit, a preview) has other chunks: measure them afresh.
  useLayoutEffect(() => {
    heights.current = new Map();
    measured.current = { px: 0, chars: 0 };
  }, [doc]);

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
  }, [doc, folded, !!editing?.whole]);

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

  const scrollPast = (where: 'before' | 'after') => scrollPastDoc(root.current, where);

  // ---- what an edit changed: marked briefly when a new version arrives, or when asked to show it ----
  const flashDue = useRef(false);
  const seenVersion = useRef(version);
  if (seenVersion.current !== version) {
    seenVersion.current = version;
    flashDue.current = true;
  }
  const flashChanged = useCallback(() => {
    const el = body.current;
    if (!el) return;
    for (const [a, z] of meta.changed ?? [])
      for (let i = a; i <= z; i++) {
        const b = el.querySelector<HTMLElement>(`[data-block="${i}"]`);
        if (!b) continue;
        b.classList.remove('doc-changed');
        void b.offsetWidth;
        b.classList.add('doc-changed');
      }
  }, [meta.changed]);
  useEffect(() => {
    if (!flashDue.current || preview || !doc) return;
    flashDue.current = false;
    const raf = requestAnimationFrame(flashChanged);
    return () => cancelAnimationFrame(raf);
  }, [doc]);
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id !== m.id) return;
      if (folded) setFolded(false);
      if (detail.version && detail.version !== version) {
        root.current?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
        documentApi.versions(m.id).then((r) => {
          const v = r.versions.find((x) => x.version === detail.version);
          if (v) showVersion(v);
        });
        return;
      }
      setPreview(null);
      const first = meta.changed?.[0]?.[0];
      if (first !== undefined) jumpTo(first, 'center');
      else root.current?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      flashDue.current = true;
      setTimeout(flashChanged, 60);
    };
    window.addEventListener(REVEAL_EDIT, on);
    return () => window.removeEventListener(REVEAL_EDIT, on);
  }, [m.id, meta.changed, folded, flashChanged, version]);

  // Someone else saved while a section is open: keep the editor on its section (found by its heading).
  useEffect(() => {
    if (!editing || editing.whole || !parsed?.lines || !doc || editing.base === version) return;
    const first = editing.original.split('\n')[0];
    const heads = firstLines(m.content, parsed.lines);
    const hit = heads.findIndex((l) => l === first);
    const last = parsed.blocks.length - 1;
    const [from, to] = hit >= 0 ? sectionOf(doc.headings, parsed.blocks.length, hit) : [Math.min(editing.from, last), Math.min(editing.to, last)];
    if (from !== editing.from || to !== editing.to) setEditing((e) => e && { ...e, from, to });
  }, [doc]);

  // An editor that opens off screen, or low on it, comes up under the header.
  const editKey = editing ? `${editing.whole}:${editing.from}` : '';
  useLayoutEffect(() => {
    const scroller = scrollerOf(root.current);
    const el = root.current?.querySelector('.doc-editor');
    if (!editKey || !scroller || !el) return;
    // The reader's own move: the view must not follow the bottom as the editor grows.
    scroller.dispatchEvent(new Event(SCROLL_INTENT));
    const headH = head.current?.offsetHeight ?? 0;
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (r.top >= s.top + headH && r.top <= s.top + s.height * 0.45) return;
    scroller.scrollTo({ top: scroller.scrollTop + r.top - s.top - headH - 12, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [editKey]);

  const onEdit = (at: number) => {
    if (!doc) return;
    if (folded) setFolded(false);
    if (m.content.length <= WHOLE_EDIT_MAX || !doc.headings.length) return startEdit('whole');
    startEdit(at >= 0 ? at : -1);
  };
  const showVersion = async (v: DocVersion) => {
    if (v.version === version) return setPreview(null);
    const { content } = await documentApi.version(m.id, v.version);
    setEditing(null);
    setPreview({ version: v.version, content, info: v });
  };

  return (
    <div ref={root} className={`msg doc ${props.flash ? 'flash' : ''} ${editing ? 'is-editing' : ''}`} id={`m-${m.id}`} data-message-id={m.id}>
      <DocHeader
        headRef={head}
        rootRef={root}
        bodyRef={body}
        docId={m.id}
        meta={meta}
        sharedAt={m.createdAt}
        parsed={parsed}
        doc={doc}
        threads={threads}
        folded={folded}
        contentsOpen={contentsOpen}
        editing={!!editing}
        preview={preview?.version ?? null}
        onContents={() => contents?.toggle(m.id)}
        onAt={contentsOpen ? contents!.setAt : undefined}
        onFold={toggleFold}
        onPast={scrollPast}
        onOpenThread={(t) => (t.blockIndex < 0 ? navigate({ ...parseRoute(), threadId: t.id }) : onOpenThread?.(m, t.blockIndex, t.blockEnd))}
        onEdit={canEdit ? onEdit : undefined}
        editLabel={m.content.length > WHOLE_EDIT_MAX && doc?.headings.length ? 'Edit this section' : 'Edit the document'}
        onVersion={showVersion}
      />
      {!folded && (
        <div ref={fold} className="doc-fold">
          {preview && <PreviewBar docId={m.id} preview={preview} current={version} onClose={() => setPreview(null)} />}
          {editing?.whole ? (
            editor
          ) : (
            <div ref={body} className={`doc-body ${preview ? 'is-preview' : ''}`}>
              {parsed &&
                doc?.chunks.map((c, k) => (
                  <DocChunk key={k} k={k} chunk={c} parsed={parsed} rendered={rendered(k)} height={rendered(k) ? 0 : heightOf(k)} renderBlock={renderBlock} />
                ))}
            </div>
          )}
          <div className="doc-end">
            <span className="promoted-rule" />
            <span>
              End of {meta.name}
              {preview ? ` version ${preview.version}` : ''} ·{' '}
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

/** Scrolls to the end of the conversation before a document, or just past the document. */
export function scrollPastDoc(el: HTMLElement | null, where: 'before' | 'after') {
  const scroller = scrollerOf(el);
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
}

/** The first source line of each block (a section is found again by its heading line). */
function firstLines(content: string, lines: [number, number][]): string[] {
  const src = content.split('\n');
  return lines.map(([a]) => src[a] ?? '');
}

/** Over an older version: whose it was, and the way back to the current one or to restore it. */
function PreviewBar({ docId, preview, current, onClose }: { docId: string; preview: Preview; current: number; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const by = preview.info.by;
  return (
    <div className="doc-preview-bar" role="status">
      <ClockCounterClockwise size={15} aria-hidden />
      <span className="doc-preview-text">
        Version {preview.version} of {current} ·{' '}
        <span style={by.kind === 'agent' ? { color: agentColor(by.id) } : undefined}>{editorName(by)}</span>
        {preview.info.restored ? ` restored version ${preview.info.restored}` : ''} · {relTime(preview.info.createdAt)}
        {error && <span className="doc-preview-error"> · {error}</span>}
      </span>
      <span className="doc-preview-actions">
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await documentApi.restore(docId, preview.version, current);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Restore this version
        </button>
        <button className="btn small primary" onClick={onClose}>
          Back to the current one
        </button>
      </span>
    </div>
  );
}

/** Folded documents stay folded for this viewer. */
export function useFolded(id: string): [boolean, (v: boolean) => void] {
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
export function arrive(el: HTMLElement) {
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

export interface HeaderProps {
  headRef: RefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  docId: string;
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
  editing: boolean;
  /** The older version on screen, if any. */
  preview: number | null;
  /** Opens the editor on the section at the reading line (or the whole text); absent when it cannot. */
  onEdit?: (at: number) => void;
  editLabel: string;
  onVersion: (v: DocVersion) => void;
  /** The block at the reading line, for a body whose blocks are not boxes of their own (a PDF's). */
  blockAt?: (line: number) => number;
  /** Replaces the section trail while stuck (a PDF's names its page too). */
  whereAt?: (block: number) => string;
  /** More buttons, first in the row (a PDF's zoom). */
  tools?: ReactNode;
}

/** Sticks to the top while the document is on screen: title, current section, progress, and its menus. */
export function DocHeader({ headRef, rootRef, bodyRef, docId, meta, sharedAt, parsed, doc, threads, folded, contentsOpen, onContents, onAt, onFold, onPast, onOpenThread, editing, preview, onEdit, editLabel, onVersion, blockAt, whereAt, tools }: HeaderProps) {
  const [stuck, setStuck] = useState(false);
  // The jumps around the document only help when it is longer than the screen.
  const [long, setLong] = useState(false);
  const [first, setFirst] = useState(true);
  // The heading of the block at the reading line, and the one above it.
  const [at, setAt] = useState(-1);
  const [block, setBlock] = useState(-1);
  const [menu, setMenu] = useState<'threads' | 'history' | null>(null);
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const version = docVersion(meta);
  // The history is read when its menu opens, and again after each new version.
  useEffect(() => {
    if (menu !== 'history') return;
    let live = true;
    documentApi.versions(docId).then((r) => live && setVersions(r.versions.slice().reverse()), () => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [menu, docId, version]);
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
      let at = blockAt ? blockAt(line) : -1;
      if (!blockAt) for (const b of Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [])) {
        if (b.getBoundingClientRect().top > line) break;
        at = Number(b.dataset.block);
      }
      setBlock(at);
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
  const trail = whereAt ? (block >= 0 ? whereAt(block) : '') : doc && at >= 0 ? trailAt(doc.headings, at) : '';
  const when = version > 1 && meta.editedAt ? `version ${version} · edited by ${editorName(meta.editedBy).replace(/^You$/, 'you')} ${relTime(meta.editedAt)}` : `shared ${time(sharedAt)}`;
  const pages = isPdfDoc(meta) ? `${meta.pages.toLocaleString()} ${meta.pages === 1 ? 'page' : 'pages'} · ` : '';
  const sub = preview
    ? `viewing version ${preview} of ${version}`
    : stuck && trail
      ? trail
      : `${when} · ${pages}${words} words · ${readingTime(meta.words)}${threads.length ? ` · ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}` : ''}`;
  const attached = threads.filter((t) => t.blockIndex >= 0);
  const detached = threads.filter((t) => t.blockIndex < 0);
  useEffect(() => {
    onAt?.(at);
  }, [at, onAt]);
  const menuView = useDropdown(menu);
  useMenuDismiss(!!menu, headRef, () => setMenu(null));
  const where = (index: number) => (doc ? doc.offsets[index] / doc.chars : 0);

  return (
    <div ref={headRef} className="doc-head" data-stuck={stuck && !folded}>
      <span className="doc-icon" aria-hidden>
        {isPdfDoc(meta) ? <FilePdf size={18} /> : <FileMd size={18} />}
      </span>
      <div className="doc-title">
        <span className="doc-name">{meta.name}</span>
        <SwapText className="doc-sub" text={sub} />
      </div>
      <span className="doc-actions">
        {!folded && tools}
        {!folded && doc && doc.headings.length > 1 && (
          <button className={`doc-btn ${contentsOpen ? 'on' : ''}`} onClick={onContents} data-tooltip={contentsOpen ? 'Close contents' : 'Contents'} aria-label="Contents" aria-expanded={contentsOpen}>
            <ListDashes size={16} />
          </button>
        )}
        {onEdit && (
          <button
            className={`doc-btn ${editing ? 'on' : ''}`}
            onClick={() => onEdit(at)}
            disabled={editing}
            data-tooltip={editing ? undefined : editLabel}
            aria-label={editLabel}
          >
            <PencilSimple size={16} />
          </button>
        )}
        {(version > 1 || preview) && (
          <button
            className={`doc-btn doc-history-btn ${menu === 'history' || preview ? 'on' : ''}`}
            onClick={() => setMenu(menu === 'history' ? null : 'history')}
            data-tooltip="Versions"
            aria-label="Versions of this document"
            aria-expanded={menu === 'history'}
          >
            <ClockCounterClockwise size={16} />
            <span className="doc-btn-label">
              <PopNumber value={`v${preview ?? version}`} />
            </span>
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
          {(preview ? [] : attached).map((t) => (
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
      {menuView.shown === 'history' && (
        <div className={`doc-menu ${menuView.className}`} data-origin="top-right" role="menu">
          <div className="doc-menu-title">Versions</div>
          {!versions && <div className="doc-menu-empty muted">Loading…</div>}
          {versions?.map((v) => (
            <button
              key={v.version}
              className={`dd-item doc-version-item ${(preview ?? version) === v.version ? 'on' : ''}`}
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onVersion(v);
              }}
            >
              <span className="dd-title">
                Version {v.version}
                {v.version === version && <span className="doc-version-tag">current</span>}
              </span>
              <span className="dd-sub">
                <span style={v.by.kind === 'agent' ? { color: agentColor(v.by.id) } : undefined}>{editorName(v.by)}</span>
                {v.version === 1 ? ' shared it' : v.restored ? ` restored version ${v.restored}` : v.threadId ? ' edited it from a thread' : ' edited it'} · {relTime(v.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}
      {menuView.shown === 'threads' && (
        <div className={`doc-menu ${menuView.className}`} data-origin="top-right" role="menu">
          <div className="doc-menu-title">
            {threads.length} {threads.length === 1 ? 'thread' : 'threads'} on this document
          </div>
          {attached.map((t) => {
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
                  {t.anchor === 'changed' ? `passage edited in version ${t.anchorVersion} · ` : ''}
                  {sec && sec.index !== t.blockIndex ? `${sec.text} · ` : ''}
                  {t.channel ? `became #${t.channel.name}` : `${t.replyCount} ${t.replyCount === 1 ? 'reply' : 'replies'} · ${relTime(t.lastActivity)}`}
                </span>
              </button>
            );
          })}
          {detached.length > 0 && <div className="doc-menu-title">No longer in the document</div>}
          {detached.map((t) => (
            <button
              key={t.id}
              className="dd-item doc-thread-item is-detached"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenThread(t);
              }}
            >
              <span className="dd-title">{t.quote ?? 'Passage'}</span>
              <span className="dd-sub">
                removed or rewritten in version {t.anchorVersion} · {t.replyCount} {t.replyCount === 1 ? 'reply' : 'replies'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Closes a header menu on Esc (before the thread panel sees it) or a press outside the header. */
export function useMenuDismiss(open: boolean, inside: RefObject<HTMLElement | null>, close: () => void) {
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
