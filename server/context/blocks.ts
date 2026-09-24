import { Marked } from 'marked';

const md = new Marked({ gfm: true, breaks: false });

/** Raw markdown of each top-level block, skipping space tokens. Must match web/src/lib/markdown.ts. */
export function blocksOf(source: string): string[] {
  return md
    .lexer(source)
    .filter((t) => t.type !== 'space')
    .map((t) => t.raw.trim());
}
