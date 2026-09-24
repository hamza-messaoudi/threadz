import { isElement, nodeSource, type ElementNode, type Node } from '../../../shared/markdown.ts';

export interface Block {
  /** Matches the server's block_index for the same message. */
  index: number;
  node: ElementNode;
}

/** Top-level element nodes, in order. Whitespace text and dropped comments are skipped. */
export function splitBlocks(nodes: Node[]): Block[] {
  const out: Block[] = [];
  for (const n of nodes) if (isElement(n)) out.push({ index: out.length, node: n });
  return out;
}

/** A block serialised back to markdown (what a thread quotes). */
export async function blockSource(node: Node): Promise<string> {
  return (await nodeSource(node)).trim();
}
