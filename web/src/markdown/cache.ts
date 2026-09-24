import type { Parsed } from './parse.ts';

/** Small LRU of final parse results, keyed by message ID + content hash. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}

/** FNV-1a, 32 bit. Enough to tell two versions of one message apart. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}

export const finalTrees = new LruCache<Parsed>(500);
export const cacheKey = (id: string, content: string) => `${id}#${hash(content)}`;
