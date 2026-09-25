import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { ElementNode, Node } from '../../../shared/markdown.ts';
import { durationVar } from '../lib/usePresence.ts';

// transitions.dev "Streaming text" for a message that is still arriving: the last block's prose words
// become .t-stream-w spans, and useStreamWords resolves new ones in order, one every --stream-gap.

/** Only prose is split; code, tables and figures keep their own rendering. */
const PROSE = new Set(['p', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'a', 'mark']);

export function streamWords(node: ElementNode): ElementNode {
  return PROSE.has(node[0]) ? (wrap(node)[0] as ElementNode) : node;
}

/** One node in, the nodes that replace it out (a text node becomes words and the spaces between). */
function wrap(node: Node): Node[] {
  if (typeof node === 'string') return node.split(/(\s+)/).filter(Boolean).map((w) => (/^\s+$/.test(w) ? w : (['span', { class: 't-stream-w' }, w] as Node)));
  if (!Array.isArray(node) || typeof node[0] !== 'string' || !PROSE.has(node[0])) return [node];
  const [tag, props, ...children] = node as ElementNode;
  return [[tag, props, ...children.flatMap(wrap)] as Node];
}

/** However fast text arrives, words queue for at most this long. */
const MAX_BACKLOG_MS = 500;

/** Adds .is-in to each new word span under `root`, in document order. */
export function useStreamWords(root: RefObject<HTMLElement | null>, active: boolean) {
  const queue = useRef<HTMLElement[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const next = () => {
    timer.current = null;
    let el: HTMLElement | undefined;
    while ((el = queue.current.shift()) && (!el.isConnected || el.classList.contains('is-in')));
    if (!el) return;
    el.classList.add('is-in');
    const gap = Math.min(durationVar('--stream-gap', 60), MAX_BACKLOG_MS / Math.max(queue.current.length, 1));
    timer.current = setTimeout(next, gap);
  };

  // After every render: pick up the words that have not resolved yet.
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    queue.current = Array.from(root.current.querySelectorAll<HTMLElement>('.t-stream-w:not(.is-in)'));
    if (!timer.current) next();
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
}
