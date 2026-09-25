import { useLayoutEffect, type RefObject } from 'react';
import type { ElementNode, Node } from '../../../shared/markdown.ts';

// transitions.dev "Streaming text" for a message that is still arriving: the last block's prose words
// become .t-stream-w spans, and useStreamWords fades each new one in.

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

/**
 * Adds .is-in to each new word span under `root`, two frames after it mounts: one frame painted at
 * opacity 0, so the fade runs. The pace comes from the text itself (useSmoothText), not a queue here.
 */
export function useStreamWords(root: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    const fresh = root.current.querySelectorAll<HTMLElement>('.t-stream-w:not(.is-in)');
    if (!fresh.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach((el) => el.classList.add('is-in'))));
  });
}
