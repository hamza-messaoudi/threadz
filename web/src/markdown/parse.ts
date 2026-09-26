import { parseComark, type Node } from '../../../shared/markdown.ts';
import { splitBlocks, type Block } from './blocks.ts';
import { cacheKey, finalTrees } from './cache.ts';
import { componentTags } from './tags.ts';
import { sanitizeNodes } from './sanitize.ts';

export interface Parsed {
  tree: Node[];
  blocks: Block[];
  /** Source lines [start, end) of each block, when they line up with the blocks (a document's section editor). */
  lines?: [number, number][];
}

/** Parse + sanitise. Never throws: an unparseable prefix (e.g. half-written YAML props) gives null. */
export async function parseMessage(md: string): Promise<Parsed | null> {
  try {
    const doc = await parseComark(md);
    const tree = await sanitizeNodes(doc.nodes, componentTags);
    const blocks = splitBlocks(tree);
    const ranges = (doc.meta.blockLines ?? []) as [number, number, boolean][];
    if (ranges.length !== blocks.length) return { tree, blocks };
    // A component's range stops before its closing `::` line.
    const src = md.split('\n');
    const lines = ranges.map(([a, b, component]): [number, number] => [a, component && b < src.length && /^\s*:{2,}\s*$/.test(src[b]) ? b + 1 : b]);
    return { tree, blocks, lines };
  } catch {
    return null;
  }
}

/** Parse a finished message once and keep it in the LRU (500 entries). */
export async function parseFinal(id: string, md: string): Promise<Parsed | null> {
  const key = cacheKey(id, md);
  const hit = finalTrees.get(key);
  if (hit) return hit;
  const parsed = await parseMessage(md);
  if (parsed) finalTrees.set(key, parsed);
  return parsed;
}

export const cachedFinal = (id: string, md: string) => finalTrees.get(cacheKey(id, md));
