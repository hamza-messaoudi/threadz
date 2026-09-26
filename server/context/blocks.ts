import crypto from 'node:crypto';
import { blocksOf } from '../../shared/markdown.ts';

export { blocksOf };

/**
 * A message's blocks, split once per text. A long document takes a while to split (every block is
 * parsed twice), and every thread opened on it, and every edit of it, needs the split.
 */
const blockCache = new Map<string, Promise<string[]>>();
export function blocksCached(id: string, content: string): Promise<string[]> {
  const key = `${id}:${crypto.createHash('sha1').update(content).digest('base64')}`;
  let hit = blockCache.get(key);
  if (hit) {
    blockCache.delete(key);
    blockCache.set(key, hit);
    return hit;
  }
  hit = blocksOf(content);
  hit.catch(() => blockCache.delete(key));
  blockCache.set(key, hit);
  if (blockCache.size > 32) blockCache.delete(blockCache.keys().next().value!);
  return hit;
}
