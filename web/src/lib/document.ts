// Shared Markdown documents: a user message with meta.kind 'document' (server/context/documents.ts).
import type { Node } from '../../../shared/markdown.ts';
import type { Block } from '../markdown/blocks.ts';
import { api, type Message } from './api.ts';

export interface DocMeta {
  kind: 'document';
  name: string;
  title: string | null;
  words: number;
}

export const docMeta = (m: Pick<Message, 'meta'> | undefined | null): DocMeta | null => (m?.meta?.kind === 'document' ? (m.meta as DocMeta) : null);

export const isMarkdownFile = (f: { name: string }) => /\.(md|markdown)$/i.test(f.name);

/** Reads a dropped or picked file and shares it in the thread. Only Markdown is accepted. */
export async function shareDocument(threadId: string, file: File): Promise<Message> {
  if (!isMarkdownFile(file)) throw new Error(`${file.name} is not a Markdown document (.md)`);
  return api.post<Message>(`/api/threads/${threadId}/documents`, { name: file.name, content: await file.text() });
}

/** The first Markdown file in a drop or paste, or the first file (to say why it was refused). */
export function pickFile(list: FileList | null | undefined): File | null {
  const files = Array.from(list ?? []);
  return files.find(isMarkdownFile) ?? files[0] ?? null;
}

/** "12 min read", "3 h 40 min read" at 230 words a minute. */
export function readingTime(words: number): string {
  const min = Math.max(1, Math.round(words / 230));
  return min < 60 ? `${min} min read` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} read`;
}

/** Visible text of a Comark node. */
export function nodeText(node: Node): string {
  if (typeof node === 'string') return node;
  if (!Array.isArray(node) || node[0] === null) return '';
  let out = '';
  for (let i = 2; i < node.length; i++) out += nodeText(node[i] as Node);
  return out;
}

export interface Heading {
  /** Block index of the heading. */
  index: number;
  level: 1 | 2 | 3;
  text: string;
}

/** Headings (h1–h3) of a parsed document, in order: the contents menu and the section label. */
export function outline(blocks: Block[]): Heading[] {
  const out: Heading[] = [];
  for (const b of blocks) {
    const m = /^h([123])$/.exec(b.node[0]);
    if (m) out.push({ index: b.index, level: Number(m[1]) as 1 | 2 | 3, text: nodeText(b.node).trim() });
  }
  return out;
}

/** The heading a block sits under (the last one at or before it), by binary search. */
export function sectionAt(headings: Heading[], index: number): Heading | null {
  let lo = 0;
  let hi = headings.length - 1;
  let found: Heading | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].index <= index) {
      found = headings[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Where a block sits: its heading, after the heading above that one ("2. Storage › 2.3 Indexes"). */
export function trailAt(headings: Heading[], index: number): string {
  const here = sectionAt(headings, index);
  if (!here) return '';
  const i = headings.indexOf(here);
  let parent: Heading | undefined;
  for (let j = i - 1; j >= 0 && !parent; j--) if (headings[j].level < here.level) parent = headings[j];
  return parent && parent.level > 1 ? `${parent.text} › ${here.text}` : here.text;
}

/** A run of blocks rendered (or held as a sized placeholder) together. */
export interface Chunk {
  /** First block index, inclusive. */
  from: number;
  /** Last block index, exclusive. */
  to: number;
  /** Characters of text, for the height estimate of a chunk not yet measured. */
  chars: number;
}

/**
 * Splits a document into chunks of about `target` characters (a screen or two of prose). A chunk
 * that is at least half full ends before a heading, so sections tend to start a chunk.
 */
export function chunkBlocks(blocks: Block[], target = 5000, maxBlocks = 40): Chunk[] {
  const out: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const b of blocks) {
    const size = nodeText(b.node).length + 40; // a block's own margins count as text too
    const heading = /^h[1-3]$/.test(b.node[0]);
    if (cur && (cur.chars + size > target * 1.5 || cur.to - cur.from >= maxBlocks || (heading && cur.chars >= target / 2) || cur.chars >= target)) {
      out.push(cur);
      cur = null;
    }
    cur ??= { from: b.index, to: b.index, chars: 0 };
    cur.to = b.index + 1;
    cur.chars += size;
  }
  if (cur) out.push(cur);
  return out;
}

/** The chunk holding a block. */
export function chunkOf(chunks: Chunk[], index: number): number {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid].from <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A passage's opening words, for menus. */
export function excerpt(blocks: Block[], index: number, max = 90): string {
  const b = blocks[index];
  if (!b) return '';
  const text = nodeText(b.node).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
