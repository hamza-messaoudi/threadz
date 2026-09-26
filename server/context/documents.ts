import type { MessageRow } from '../db/queries.ts';
import { isPdfMeta, renderPdf } from './pdf.ts';

/**
 * A shared Markdown document is a user message with meta.kind 'document': it sits in the timeline like
 * any message, renders in full, and its blocks take side threads like a reply's paragraphs do.
 */
export interface DocumentMeta {
  kind: 'document';
  /** File name as shared, e.g. "spec.md". */
  name: string;
  /** The first level-1 heading, if the document starts with one. */
  title: string | null;
  words: number;
}

export const DOCUMENT_NAME_RE = /\.(md|markdown)$/i;
/** About 600 pages of prose; a 100-page document is ~300 KB. */
export const MAX_DOCUMENT_CHARS = 2_000_000;
/**
 * From this length on (~5k tokens), a document's first side thread per agent reads it once in a reader
 * session that later threads fork (006-document-sessions.sql). Shorter documents are cheaper to send
 * with each thread than to read in a turn of their own.
 */
export const READER_MIN_CHARS = 20_000;

export function documentMeta(m: Pick<MessageRow, 'meta'> | undefined): DocumentMeta | null {
  if (!m?.meta) return null;
  try {
    const meta = JSON.parse(m.meta);
    return meta?.kind === 'document' && typeof meta.name === 'string' ? meta : null;
  } catch {
    return null;
  }
}

/** Title and size of a document's source (line endings already normalised). */
export function describeDocument(name: string, content: string): DocumentMeta {
  const title = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(content.split('\n').find((l) => l.trim()) ?? '')?.[1] ?? null;
  const words = content.split(/\s+/).filter(Boolean).length;
  return { kind: 'document', name, title, words };
}

/**
 * The document as the agent reads it. A pure function of name and text, with no time stamps, so the
 * same document is byte-identical in every prompt that carries it.
 */
export function renderDocument(meta: Pick<DocumentMeta, 'name'>, content: string): string {
  if (isPdfMeta(meta)) return renderPdf(meta, content);
  return `<document name="${attr(meta.name)}">\n${content.trim()}\n</document>`;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Documents lead a seeded session's first prompt, complete and in the order they were shared. */
export function renderSharedDocuments(docs: MessageRow[]): string {
  if (!docs.length) return '';
  const body = docs.map((m) => renderDocument(documentMeta(m)!, m.content_md)).join('\n\n');
  const head =
    docs.length === 1
      ? 'The user shared this document in the conversation. It is complete; answer from all of it.'
      : 'The user shared these documents in the conversation. Each is complete; answer from all of them.';
  return `<shared_documents>\n${head}\n\n${body}\n</shared_documents>`;
}

/** A short note for the first turn of a document's reader session (the model only acknowledges it). */
export function renderReaderNote(meta: DocumentMeta): string {
  return `<document_ready>\nThe user is about to open side threads on passages of the document "${meta.name}" above and ask about them there. Nothing to do yet: reply with just "ok", without using any tools.\n</document_ready>`;
}
