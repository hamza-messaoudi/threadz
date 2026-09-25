import { useCallback, useEffect, useRef, useState } from 'react';
import { durationVar } from './usePresence.ts';

/**
 * transitions.dev "Modal open / close" for a dialog its parent mounts and unmounts: it opens a frame
 * after mounting (.is-open scales up from --modal-scale), and `close` plays .is-closing before
 * calling `onClose`, which unmounts it. Use `close` for every way out (backdrop, Esc, Cancel, done).
 */
export function useModal(onClose: () => void) {
  const [phase, setPhase] = useState<'enter' | 'open' | 'closing'>('enter');
  const closing = useRef(false);
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setPhase((p) => (p === 'enter' ? 'open' : p)))));
    return () => cancelAnimationFrame(raf);
  }, []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setPhase('closing');
    setTimeout(() => latest.current(), durationVar('--modal-close-dur', 150));
  }, []);

  const state = phase === 'open' ? 'is-open' : phase === 'closing' ? 'is-closing' : '';
  return { close, modalClass: `t-modal ${state}`, backdropClass: `modal-backdrop ${state}` };
}
