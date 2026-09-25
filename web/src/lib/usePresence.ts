import { useEffect, useRef, useState } from 'react';

export type PresencePhase = 'enter' | 'open' | 'closing';

/** A duration token from :root in ms; the browser may hand it back normalised to seconds (".15s"). */
export function durationVar(name: string, fallback: number): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) ? (/[^m]s$/.test(v) ? n * 1000 : n) : fallback;
}

/**
 * Keeps something mounted through its close transition. While `value` is set it is shown: first in
 * the 'enter' phase (paint the closed state), then 'open' a frame later so CSS can transition. When
 * `value` clears, the last one stays in the 'closing' phase for the `closeVar` duration.
 */
export function usePresence<T>(value: T | null | undefined, closeVar: string, closeFallback: number): { shown: T | null; phase: PresencePhase } {
  const open = value != null;
  const [phase, setPhase] = useState<PresencePhase | 'gone'>(open ? 'enter' : 'gone');
  const last = useRef<T | null>(value ?? null);
  if (open) last.current = value;

  useEffect(() => {
    if (open) {
      setPhase((p) => (p === 'open' ? p : 'enter'));
      // Two frames: the first paints the closed state, so the second has something to transition from.
      let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setPhase('open'))));
      return () => cancelAnimationFrame(raf);
    }
    setPhase((p) => (p === 'gone' ? p : 'closing'));
    const t = setTimeout(() => setPhase('gone'), durationVar(closeVar, closeFallback));
    return () => clearTimeout(t);
  }, [open, closeVar, closeFallback]);

  if (!open && phase === 'gone') return { shown: null, phase: 'closing' };
  return { shown: last.current, phase: !open ? 'closing' : phase === 'open' ? 'open' : 'enter' };
}
