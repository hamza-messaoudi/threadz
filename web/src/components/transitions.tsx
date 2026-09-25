// React wrappers for transitions.dev snippets (CSS in styles.css). Each keeps the snippet's JS
// orchestration: class swaps, forced reflows and timings read from the :root tokens.
import { CaretDown, Check } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { durationVar } from '../lib/usePresence.ts';

/** Accordion expand: the panel grows via grid rows 0fr ↔ 1fr and the chevron flips. */
export function Accordion({ open, head, children, className }: { open: boolean; head?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`t-acc ${className ?? ''}`} data-open={open}>
      {head}
      <div className="t-acc-panel">
        <div className="t-acc-panel-inner" inert={!open}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function AccChevron() {
  return (
    <span className="t-acc-chevron" aria-hidden>
      <CaretDown size={12} />
    </span>
  );
}

/** Keeps the last non-null value, so a closing accordion still has its content while it collapses. */
export function useLatest<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null);
  if (value != null) last.current = value;
  return last.current;
}

/** Number pop-in: digits re-enter with a blurred slide whenever the value changes (not on first paint). */
export function PopNumber({ value }: { value: number | string }) {
  const first = useRef(value);
  const str = String(value);
  const chars = str.split('');
  return (
    // A new key per value remounts the digits, which restarts the keyframes (the snippet's reflow).
    <span key={str} className={`t-digit-group ${value !== first.current ? 'is-animating' : ''}`}>
      {chars.map((ch, i) => (
        <span key={i} className="t-digit" data-stagger={i === chars.length - 1 && chars.length > 1 ? '2' : i === chars.length - 2 ? '1' : undefined}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/** Text states swap: the old text exits up, the new one enters from below. */
export function SwapText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useEffect(() => {
    if (text === shown) return;
    const el = ref.current!;
    el.classList.add('is-exit');
    const t = setTimeout(() => {
      setShown(text);
      el.classList.remove('is-exit');
      el.classList.add('is-enter-start');
    }, durationVar('--text-swap-dur', 150));
    return () => clearTimeout(t);
  }, [text, shown]);
  // After the new text is in the DOM: force a reflow, then release it so it animates back to rest.
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!el.classList.contains('is-enter-start')) return;
    void el.offsetHeight;
    el.classList.remove('is-enter-start');
  }, [shown]);
  return (
    <span ref={ref} className={`t-text-swap ${className ?? ''}`}>
      {shown}
    </span>
  );
}

/** Success check: fade + rotate + bob + stroke-draw, played each time `play` changes to a new truthy key. */
export function SuccessCheck({ play }: { play: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (!play) return el.setAttribute('data-state', 'out');
    el.setAttribute('data-state', 'out');
    void el.offsetWidth; // restart the keyframes
    el.setAttribute('data-state', 'in');
  }, [play]);
  return (
    <span ref={ref} className="t-success-check success-check" data-state="out" aria-hidden="true">
      <Check size={12} weight="bold" />
    </span>
  );
}

/** Tabs sliding: a pill slides under the selected tab. */
export function SlidingTabs<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  const moveTo = (animate: boolean) => {
    const tab = bar.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const p = pill.current;
    if (!tab || !p) return;
    if (!animate) {
      const prev = p.style.transition;
      p.style.transition = 'none';
      p.style.transform = `translateX(${tab.offsetLeft}px)`;
      p.style.width = `${tab.offsetWidth}px`;
      void p.offsetWidth;
      p.style.transition = prev;
    } else {
      p.style.transform = `translateX(${tab.offsetLeft}px)`;
      p.style.width = `${tab.offsetWidth}px`;
    }
  };
  // First paint snaps into place; later selections slide.
  useLayoutEffect(() => {
    moveTo(placed.current);
    placed.current = true;
  }, [value]);
  useEffect(() => {
    const on = () => moveTo(false);
    window.addEventListener('resize', on);
    document.fonts?.ready.then(on);
    return () => window.removeEventListener('resize', on);
  }, []);

  return (
    <div ref={bar} className="t-tabs" role="tablist" aria-label={label}>
      <span ref={pill} className="t-tabs-pill" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} className="t-tab" role="tab" aria-selected={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Skeleton loader and reveal: a pulsing placeholder until `loaded`, then a cross-fade + cross-blur to
 * the content. The content stays in the flow (the snippet stacks both absolutely) so a list of any
 * height fits; the skeleton overlays it and leaves the DOM once the reveal is over.
 */
export function SkeletonReveal({ loaded, skeleton, children, className }: { loaded: boolean; skeleton: ReactNode; children: ReactNode; className?: string }) {
  const [skelMounted, setSkelMounted] = useState(!loaded);
  const [revealed, setRevealed] = useState(loaded);
  useEffect(() => {
    if (!loaded) return;
    const raf = requestAnimationFrame(() => setRevealed(true));
    const t = setTimeout(() => setSkelMounted(false), durationVar('--reveal-dur', 400));
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [loaded]);
  return (
    <div className={`t-skel skel-flow ${revealed ? 'is-revealed' : ''} ${className ?? ''}`}>
      {skelMounted && (
        <div className="t-skel-skeleton is-pulsing" aria-hidden="true">
          {skeleton}
        </div>
      )}
      <div className="t-skel-content">{children}</div>
    </div>
  );
}

/** Placeholder rows shaped like messages: avatar, name line, two text lines. */
export function MessageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-row">
          <span className="skel-avatar" />
          <span className="skel-lines">
            <span className="skel-line short" />
            <span className="skel-line" />
            <span className={`skel-line ${i % 2 ? 'mid' : ''}`} />
          </span>
        </div>
      ))}
    </>
  );
}

/** Texts reveal: stacked lines rise in with a stagger once mounted. */
export function TextsReveal({ children, className }: { children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setShown(true))));
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className={`t-stagger ${shown ? 'is-shown' : ''} ${className ?? ''}`}>{children}</div>;
}

/**
 * Card resize for a height that goes to or from `auto`: CSS cannot tween `auto`, so the element's
 * current and target heights are written in px and .t-resize tweens between them. Once an expand
 * lands, the height goes back to `auto` so later content changes still reflow.
 */
export function useResizeHeight(ref: React.RefObject<HTMLElement | null>, target: 'auto' | string) {
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current) {
      first.current = false;
      el.style.height = target;
      return;
    }
    const from = el.getBoundingClientRect().height;
    el.style.height = target;
    const to = target === 'auto' ? el.scrollHeight : el.getBoundingClientRect().height;
    el.style.transition = 'none';
    el.style.height = `${from}px`;
    void el.offsetHeight;
    el.style.transition = '';
    el.style.height = `${to}px`;
    if (target !== 'auto') return;
    const t = setTimeout(() => {
      if (el.style.height === `${to}px`) el.style.height = 'auto';
    }, durationVar('--resize-dur', 300));
    return () => clearTimeout(t);
  }, [target]);
}

/**
 * Error state shake: when `error` becomes set, the element on `ref` shakes and gets `is-error` (the
 * border colour is the caller's CSS), the message fades in, and after --revert-hold both revert via
 * `clear`. `message` keeps the last error so it can fade out instead of vanishing.
 */
export function useErrorShake<T extends HTMLElement>(error: string | null, clear: () => void) {
  const ref = useRef<T>(null);
  const message = useLatest(error);
  const latestClear = useRef(clear);
  latestClear.current = clear;
  useEffect(() => {
    const el = ref.current;
    if (!error || !el) return;
    // Replay the shake from a clean baseline.
    el.classList.remove('is-shaking');
    void el.offsetWidth;
    el.classList.add('is-shaking');
    const shakeMs = durationVar('--shake-dur-a', 80) * 2 + durationVar('--shake-dur-b', 60) * 2;
    const stop = setTimeout(() => el.classList.remove('is-shaking'), shakeMs + 20);
    const revert = setTimeout(() => latestClear.current(), shakeMs + durationVar('--revert-hold', 3000));
    return () => {
      clearTimeout(stop);
      clearTimeout(revert);
    };
  }, [error]);
  const state = error ? 'is-error' : '';
  return { ref, message, wrapClass: `t-input-wrap ${state}`, inputClass: `t-input ${state}` };
}
