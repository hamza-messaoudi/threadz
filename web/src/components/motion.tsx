import { useEffect, useLayoutEffect, useRef } from 'react';
import { durationVar } from '../lib/usePresence.ts';

// transitions.dev "Matrix dot loader": 16 dots, each with a --d delay into the shared pulse cycle.
const CORNERS = [0, 3, 12, 15];
const RING = [1, 2, 7, 11, 14, 13, 8, 4]; // clockwise perimeter without corners
const INNER = [5, 6, 9, 10];
const TWINKLE = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4];

export type MatrixVariant = 'scan' | 'twinkle' | 'orbit' | 'pulse';

export function MatrixLoader({ variant, rounded = false, label }: { variant: MatrixVariant; rounded?: boolean; label?: string }) {
  const cycle = durationVar('--matrix-cycle', 1200);
  const dots = Array.from({ length: 16 }, (_, idx) => {
    const col = idx % 4;
    if (rounded && CORNERS.includes(idx)) return <i key={idx} className="is-gap" />;
    let d: number | null = 0;
    if (variant === 'scan') d = Math.round(col * (cycle / 10));
    else if (variant === 'twinkle') d = Math.round(TWINKLE[idx] * (cycle / 16));
    else if (variant === 'orbit') {
      const k = RING.indexOf(idx);
      d = k === -1 ? null : Math.round(k * (cycle / 8)); // the centre holds steady under the ring
    } else d = Math.round((INNER.includes(idx) ? 0 : 1) * (cycle * 0.16));
    return <i key={idx} style={d === null ? { animation: 'none' } : ({ '--d': String(d) } as React.CSSProperties)} />;
  });
  return (
    <span className="t-matrix" data-variant={variant} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {dots}
    </span>
  );
}

/** How long a state stays readable before the next one may replace it (tool calls can come in bursts). */
const MIN_READ_MS = 450;

/**
 * transitions.dev "Thinking states": a shimmering status line. Each new `text` swaps in: the old line
 * exits upward while the new one enters from below after --think-gap. A state stays up for at least
 * one swap, so a burst of changes shows the latest rather than a blur of all of them.
 */
export function ThinkingLine({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const live = useRef<HTMLSpanElement | null>(null);
  const shown = useRef('');
  const want = useRef(text);
  const busy = useRef(false);
  want.current = text;

  const line = (t: string) => {
    const el = document.createElement('span');
    el.className = 't-think-text';
    el.textContent = t;
    el.setAttribute('data-text', t); // keep the shimmer copy in sync with the visible line
    return el;
  };

  const swap = () => {
    const el = box.current;
    if (!el || busy.current || want.current === shown.current) return;
    busy.current = true;
    const swapMs = durationVar('--think-swap', 150);
    const gap = durationVar('--think-gap', 50);
    const leaving = live.current;
    leaving?.classList.add('is-exit');
    const next = line(want.current);
    next.classList.add('is-enter-start');
    el.appendChild(next);
    live.current = next;
    shown.current = want.current;
    const release = () => {
      void next.offsetWidth; // flush the enter-start rest state
      next.classList.remove('is-enter-start');
    };
    if (gap > 0) setTimeout(release, gap);
    else release();
    setTimeout(() => leaving?.remove(), swapMs + gap);
    setTimeout(() => {
      busy.current = false;
      swap(); // a newer state may have arrived meanwhile
    }, swapMs + gap + MIN_READ_MS);
  };

  useLayoutEffect(() => {
    const first = line(text);
    box.current!.appendChild(first);
    live.current = first;
    shown.current = text;
    return () => first.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(swap, [text]);

  return (
    <span ref={box} className={`t-think ${className ?? ''}`} role="status">
      <span className="t-think-sizer" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
