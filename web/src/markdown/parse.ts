import { parseComark, type Node } from '../../../shared/markdown.ts';
import { splitBlocks, type Block } from './blocks.ts';
import { cacheKey, finalTrees } from './cache.ts';
import { componentTags } from './tags.ts';
import { sanitizeNodes } from './sanitize.ts';

export interface Parsed {
  tree: Node[];
  blocks: Block[];
}

/** Parse + sanitise. Never throws: an unparseable prefix (e.g. half-written YAML props) gives null. */
export async function parseMessage(md: string): Promise<Parsed | null> {
  try {
    const doc = await parseComark(md);
    const tree = await sanitizeNodes(doc.nodes, componentTags);
    return { tree, blocks: splitBlocks(tree) };
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
