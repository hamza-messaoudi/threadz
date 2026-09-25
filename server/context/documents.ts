import type { MessageRow } from '../db/queries.ts';
import { unifiedDiff } from './diff.ts';

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
  /** Version of the text in content_md; absent until the first edit (version 1). */
  version?: number;
  /** Who made the latest version, and when. */
  editedBy?: { kind: 'user' | 'agent'; id: string | null };
  editedAt?: number;
  /** Blocks of this version that the latest edit changed or added, as [first, last] ranges. */
  changed?: [number, number][];
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

export const docVersion = (meta: Pick<DocumentMeta, 'version'> | null | undefined) => meta?.version ?? 1;

/**
 * The document as the agent reads it. A pure function of name, version and text, with no time stamps,
 * so the same version is byte-identical in every prompt that carries it (version 1 carries no number,
 * as before documents could be edited).
 */
export function renderDocument(meta: Pick<DocumentMeta, 'name' | 'version'>, content: string): string {
  const v = docVersion(meta) > 1 ? ` version="${docVersion(meta)}"` : '';
  return `<document name="${attr(meta.name)}"${v}>\n${content.trim()}\n</document>`;
}

/**
 * How an agent edits a shared document: a block in its reply that the app applies when the turn ends
 * (server/core/documents.ts). Nothing is written to disk; the user sees a new version they can undo.
 */
export const DOCUMENT_EDIT_HELP = `<document_editing>
When the user asks you to change a shared document, write the change in your reply as a block like this (outside code fences); the app applies it when your reply is done and keeps the previous version:
<document_edit name="spec.md">
<replace>
text copied verbatim from the current version: whole lines, enough to occur only once
</replace>
<with>
the new text (empty to delete it)
</with>
</document_edit>
Use one <replace>/<with> pair per change; several pairs apply in order. To rewrite the whole document instead, put its complete new text in <content>…</content>. Only edit when asked, and say in a sentence what you changed.
</document_editing>`;

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Documents lead a seeded session's first prompt, complete and in the order they were shared. */
export function renderSharedDocuments(docs: MessageRow[]): string {
  if (!docs.length) return '';
  const body = docs.map((m) => renderDocument(documentMeta(m)!, m.content_md)).join('\n\n');
  const head =
    docs.length === 1
      ? 'The user shared this document in the conversation. It is complete; answer from all of it.'
      : 'The user shared these documents in the conversation. Each is complete; answer from all of them.';
  return `<shared_documents>\n${head}\n\n${body}\n</shared_documents>\n\n${DOCUMENT_EDIT_HELP}`;
}

/** Up to this share of the document, an update shows the changes; past it (or for a short document), the whole new text. */
const DIFF_MAX_SHARE = 0.3;

/**
 * Tells a session that has read version `from` of a document what it looks like now: the changes as a
 * unified diff against the version it read, or the whole text when that is shorter or the document is
 * short (a short document is cheaper to read again than to patch in the model's head). Appended to the
 * session, so its cached prefix, with the old version in it, still hits.
 */
export function renderDocumentUpdate(
  meta: DocumentMeta,
  current: string,
  from: { version: number; content: string } | null,
  editors: string[],
  passage?: string,
): string {
  const now = docVersion(meta);
  const who = editors.length ? `${editors.join(' and ')} edited` : 'The document was edited';
  const diff = from && current.length >= READER_MIN_CHARS ? unifiedDiff(from.content.trim(), current.trim()) : '';
  const head = `<document_updated name="${attr(meta.name)}" version="${now}"${from ? ` previous="${from.version}"` : ''}>`;
  const body =
    diff && diff.length <= current.length * DIFF_MAX_SHARE
      ? `${who} "${meta.name}" since you read version ${from!.version}. The changes, as a unified diff against the version you read (line numbers are its lines):\n${diff}\nEverything else is unchanged. Answer from version ${now}.`
      : `${who} "${meta.name}"${from ? ` since you read version ${from.version}` : ''}. Its full text now, which replaces the version you read:\n${renderDocument(meta, current)}`;
  return [head, body, passage, '</document_updated>'].filter(Boolean).join('\n');
}

/** A short note for the first turn of a document's reader session (the model only acknowledges it). */
export function renderReaderNote(meta: DocumentMeta): string {
  return `<document_ready>\nThe user is about to open side threads on passages of the document "${meta.name}" above and ask about them there. Nothing to do yet: reply with just "ok", without using any tools.\n</document_ready>`;
}
