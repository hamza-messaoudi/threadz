import { FileMd } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChildThread } from '../lib/api.ts';
import { sectionAt, type Heading } from '../lib/document.ts';
import { narrowScreen, useSidebar } from '../lib/useSidebar.ts';
import { usePresence } from '../lib/usePresence.ts';
import { ICONS } from './icons.tsx';

/** What the contents pane shows: published by the document whose contents are open. */
export interface ContentsSource {
  id: string;
  name: string;
  headings: Heading[];
  threads: ChildThread[];
  jump: (index: number) => void;
}

interface Control {
  /** The document whose contents are open. */
  openId: string | null;
  toggle: (id: string) => void;
  close: () => void;
  publish: (source: ContentsSource) => void;
  /** The heading at the reading line of the open document. */
  setAt: (at: number) => void;
}

const ContentsContext = createContext<Control | null>(null);
export const useContents = () => useContext(ContentsContext);

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A document's contents as a pane on the left of the conversation. Opening it collapses the sidebar
 * to its rail and takes the space; closing it gives the space back to the sidebar if it was open.
 * Expanding the sidebar meanwhile closes the pane instead.
 */
export function ContentsHost({ children }: { children: ReactNode }) {
  const { collapsed, borrow } = useSidebar();
  const [openId, setOpenId] = useState<string | null>(null);
  const [source, setSource] = useState<ContentsSource | null>(null);
  const [at, setAt] = useState(-1);

  const close = useCallback(() => {
    setOpenId(null);
    borrow(false);
  }, [borrow]);
  const toggle = useCallback(
    (id: string) => {
      if (openId === id) return close();
      // Phones keep the sidebar on its rail already; the pane slides over the conversation there.
      if (!narrowScreen()) borrow(true);
      setAt(-1);
      setOpenId(id);
    },
    [openId, close, borrow],
  );
  // The sidebar opened again (its toggle, ⌘B): it takes the space back.
  useEffect(() => {
    if (openId && !collapsed) setOpenId(null);
  }, [collapsed]);
  // Leaving the conversation gives the space back too.
  useEffect(() => () => borrow(false), [borrow]);

  const publish = useCallback((s: ContentsSource) => setSource(s), []);
  const control = useMemo<Control>(() => ({ openId, toggle, close, publish, setAt }), [openId, toggle, close, publish]);
  const pane = usePresence(openId && source?.id === openId ? source : null, '--panel-close-dur', 350);

  return (
    <ContentsContext.Provider value={control}>
      {pane.shown && <ContentsPane source={pane.shown} at={openId ? at : -1} phase={pane.phase} onClose={close} />}
      {children}
    </ContentsContext.Provider>
  );
}

function ContentsPane({ source, at, phase, onClose }: { source: ContentsSource; at: number; phase: 'enter' | 'open' | 'closing'; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  // While the reader scrolls the pane itself, it does not follow the document.
  const touched = useRef(-Infinity);
  const counts = useMemo(() => {
    const out = new Map<number, number>();
    for (const t of source.threads) {
      const h = sectionAt(source.headings, t.blockIndex);
      if (h) out.set(h.index, (out.get(h.index) ?? 0) + 1);
    }
    return out;
  }, [source.threads, source.headings]);

  // Follows the reading position: the current heading stays in the middle band of the pane.
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    const sel = el?.querySelector<HTMLElement>('.sel');
    if (!el || !sel || performance.now() - touched.current < 1500) return;
    const top = sel.offsetTop;
    const inBand = top > el.scrollTop + el.clientHeight * 0.25 && top + sel.offsetHeight < el.scrollTop + el.clientHeight * 0.75;
    if (inBand) return;
    const target = top - (el.clientHeight - sel.offsetHeight) / 2;
    el.scrollTo({ top: target, behavior: first.current || reducedMotion() ? 'auto' : 'smooth' });
    first.current = false;
  }, [at, source]);

  const touch = () => void (touched.current = performance.now());
  return (
    <aside className={`contents-pane t-resize ${phase === 'open' ? 'is-open' : ''}`} inert={phase === 'closing'} aria-label={`Contents of ${source.name}`}>
      <div className="contents-inner t-panel-slide" data-axis="x" data-open={phase === 'open'}>
        <header className="conv-head contents-head">
          <FileMd size={16} className="contents-icon" aria-hidden />
          <div className="contents-title">
            <h2>Contents</h2>
            <span className="contents-name">{source.name}</span>
          </div>
          <button className="rail-btn" onClick={onClose} data-tooltip="Close contents" aria-label="Close contents">
            {ICONS.close}
          </button>
        </header>
        <nav ref={list} className="contents-list" onWheel={touch} onTouchMove={touch} onPointerDown={touch}>
          {source.headings.map((h) => {
            const n = counts.get(h.index);
            return (
              <button key={h.index} className={`contents-item ${at === h.index ? 'sel' : ''}`} data-level={h.level} aria-current={at === h.index ? 'location' : undefined} onClick={() => {
                  source.jump(h.index);
                  // On a phone the pane covers the text it just jumped to.
                  if (narrowScreen()) onClose();
                }}>
                <span className="contents-text">{h.text || '—'}</span>
                {n ? (
                  <span className="contents-threads" data-tooltip={`${n} ${n === 1 ? 'thread' : 'threads'} in this section`}>
                    {ICONS.thread}
                    {n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
