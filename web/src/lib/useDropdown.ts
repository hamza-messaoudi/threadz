import { usePresence } from './usePresence.ts';

/**
 * transitions.dev "Menu dropdown": mounts at the pre-open scale, adds .is-open a frame later so it
 * grows in, and on close swaps to .is-closing until --dropdown-close-dur has passed. `value` is what
 * the menu renders; the last one is kept while it closes, so the menu does not empty out as it fades.
 */
export function useDropdown<T>(value: T | null | undefined): { shown: T | null; className: string } {
  const { shown, phase } = usePresence(value, '--dropdown-close-dur', 150);
  return { shown, className: `t-dropdown ${phase === 'open' ? 'is-open' : phase === 'closing' ? 'is-closing' : ''}` };
}
