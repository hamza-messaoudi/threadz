// Shared Markdown documents: a user message with meta.kind 'document' (server/context/documents.ts).
import type { Node } from '../../../shared/markdown.ts';
import type { Block } from '../markdown/blocks.ts';
import { api, type Message } from './api.ts';
import { isPdfFile, uploadPdf } from './pdf.ts';

export interface DocMeta {
  kind: 'document';
  name: string;
  title: string | null;
  words: number;
  /** Absent until the first edit (version 1). */
  version?: number;
  editedBy?: Editor;
  editedAt?: number;
  /** Blocks the latest edit changed or added, [first, last]. */
  changed?: [number, number][];
}

/** Who saved a version: the user, or an agent by name. */
export interface Editor {
  kind: 'user' | 'agent';
  id: string | null;
}

export const docMeta = (m: Pick<Message, 'meta'> | undefined | null): DocMeta | null => (m?.meta?.kind === 'document' ? (m.meta as DocMeta) : null);
export const docVersion = (meta: DocMeta | null | undefined) => meta?.version ?? 1;
export const editorName = (by: Editor | null | undefined) => (!by ? 'Someone' : by.kind === 'agent' ? `@${by.id}` : 'You');

export interface DocVersion {
  version: number;
  by: Editor;
  /** The thread an agent edited from. */
  threadId: string | null;
  /** This version brought back an older one. */
  restored: number | null;
  createdAt: number;
  chars: number;
}

/** A save the server refused because someone saved a newer version first. */
export interface DocConflict {
  message: string;
  version: number;
  editedBy: Editor | null;
}

/** One change: `find` (at offset `at` of version `base`, if known) becomes `replace`. */
export interface DocOp {
  find: string;
  replace: string;
  at?: number;
}

export const documentApi = {
  save: (id: string, body: { base: number; content?: string; ops?: DocOp[] }) => api.patch<{ message: Message; version: number; rebased: boolean; unchanged: boolean }>(`/api/documents/${id}`, body),
  restore: (id: string, version: number, base: number) => api.post<{ message: Message; version: number }>(`/api/documents/${id}/restore`, { version, base }),
  versions: (id: string) => api.get<{ current: number; versions: DocVersion[] }>(`/api/documents/${id}/versions`),
  version: (id: string, version: number) => api.get<{ version: number; content: string }>(`/api/documents/${id}/versions/${version}`),
};

/**
 * The blocks a section edit covers: a heading and everything under it, up to the next heading of its
 * level or above (a title's, up to the next heading). Before the first heading: the blocks up to it.
 * Returns [from, to], inclusive.
 */
export function sectionOf(headings: Heading[], blocks: number, index: number): [number, number] {
  const i = headings.findIndex((h) => h.index > index);
  const here = i < 0 ? headings.at(-1) : headings[i - 1];
  if (!here || here.index > index) return [0, (headings[0]?.index ?? blocks) - 1];
  // A lone h1 is the document's title: its section is the opening under it, not the whole text.
  const level = here.level === 1 && headings.filter((h) => h.level === 1).length === 1 ? 3 : here.level;
  const next = headings.find((h) => h.index > here.index && h.level <= level);
  return [here.index, (next?.index ?? blocks) - 1];
}

/** The source of blocks from..to (inclusive), exactly as written, and where it starts in the text. */
export function sourceOf(content: string, lines: [number, number][], from: number, to: number): { text: string; at: number } {
  const src = content.split('\n');
  const start = lines[from][0];
  const end = lines[to][1];
  let at = 0;
  for (let i = 0; i < start; i++) at += src[i].length + 1;
  return { text: src.slice(start, end).join('\n'), at };
}

/**
 * An agent's reply without its <document_edit> blocks (the server applies them and the reply shows
 * the results). While the reply streams, a block still being written is cut too, and named in `drafting`.
 */
export function withoutEdits(content: string): { text: string; drafting: string | null } {
  if (!content.includes('<document_edit')) return { text: content, drafting: null };
  let text = content.replace(/<document_edit\b[^>]*>[\s\S]*?<\/document_edit>/g, '');
  let drafting: string | null = null;
  const open = text.search(/<document_edit\b/);
  if (open >= 0) {
    drafting = /name\s*=\s*"([^"]*)"/.exec(text.slice(open))?.[1] ?? 'the document';
    text = text.slice(0, open);
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), drafting };
}

export const isMarkdownFile = (f: { name: string }) => /\.(md|markdown)$/i.test(f.name);
/** What can be shared as a document: Markdown, or a PDF (read-only, lib/pdf.ts). */
export const isDocumentFile = (f: { name: string; type?: string }) => isMarkdownFile(f) || isPdfFile(f);
/** "report", from "report.pdf" or "notes.md". */
export const bareName = (name: string) => name.replace(/\.(md|markdown|pdf)$/i, '');

/** Reads a dropped or picked file and shares it in the thread. Markdown goes as text, a PDF as its bytes. */
export async function shareDocument(threadId: string, file: File): Promise<Message> {
  if (isPdfFile(file)) return uploadPdf<Message>(threadId, file);
  if (!isMarkdownFile(file)) throw new Error(`${file.name} is not a Markdown or PDF document`);
  return api.post<Message>(`/api/threads/${threadId}/documents`, { name: file.name, content: await file.text() });
}

/** The first document in a drop or paste, or the first file (to say why it was refused). */
export function pickFile(list: FileList | null | undefined): File | null {
  const files = Array.from(list ?? []);
  return files.find(isDocumentFile) ?? files[0] ?? null;
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

/**
 * Asks a document on screen to show a version (an edit note, an agent's edit result): the current one
 * with what its edit changed marked, or an older one as a preview.
 */
export const REVEAL_EDIT = 'doc:reveal-edit';
export const revealEdit = (documentId: string, version?: number) => window.dispatchEvent(new CustomEvent(REVEAL_EDIT, { detail: { id: documentId, version } }));
