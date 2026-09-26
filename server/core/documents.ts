import type { AppContext } from '../app.ts';
import { blocksCached } from '../context/blocks.ts';
import { matchSeq } from '../context/diff.ts';
import { docVersion, documentMeta, MAX_DOCUMENT_CHARS, describeDocument, type DocumentMeta } from '../context/documents.ts';
import { isPdfMeta } from '../context/pdf.ts';
import type { DocVersionRow, MessageRow, ThreadRow } from '../db/queries.ts';
import { KeyedMutex } from '../runner/locks.ts';
import { HttpError } from './dispatch.ts';
import { publishChildSummary, serializeMessage } from './serialize.ts';

/** Replace `find` (which must occur once) with `replace`. `at` is where `find` starts in the base version, if known. */
export interface EditOp {
  find: string;
  replace: string;
  at?: number;
}

export interface Editor {
  kind: 'user' | 'agent';
  /** Agent name. */
  id: string | null;
  /** The thread an agent edited from. */
  threadId?: string | null;
}

export interface EditInput {
  /** The version the edit was made against. Omitted: the current one. */
  base?: number;
  /** The whole new text, or ops on the current text, or an older version to bring back. */
  content?: string;
  ops?: EditOp[];
  restore?: number;
  by: Editor;
}

export interface EditResult {
  document: MessageRow;
  version: number;
  previous: number;
  /** The edit was made against an older version and applied on top of the edits since. */
  rebased: boolean;
  /** Nothing changed: no new version. */
  unchanged: boolean;
  notice?: MessageRow;
}

/** The document changed since the editor's version, and the edit cannot be applied on top of that. */
export class EditConflict extends HttpError {
  constructor(
    message: string,
    readonly current: { version: number; editedBy: DocumentMeta['editedBy'] | null },
  ) {
    super(409, message);
  }
}

/** One edit of a document at a time, so two racing edits both see the other's version. */
const locks = new KeyedMutex();

const who = (by: DocumentMeta['editedBy'] | null | undefined) => (!by ? 'someone' : by.kind === 'agent' ? `@${by.id}` : 'you');

/**
 * Saves a new version of a shared document: the user's (the pencil, a restore) or an agent's (a
 * <document_edit> block in its reply). Edits race safely: they run one at a time per document, and one
 * made against an older version either applies on top of the newer one (ops whose text is still there
 * exactly once) or is refused with a conflict that names the version in the way. Nothing is lost:
 * every version is kept. Threads on the document follow their passage (see reanchor).
 */
export async function editDocument(ctx: AppContext, messageId: string, input: EditInput): Promise<EditResult> {
  const release = await locks.acquire(messageId);
  try {
    return await edit(ctx, messageId, input);
  } finally {
    release();
  }
}

async function edit(ctx: AppContext, messageId: string, input: EditInput): Promise<EditResult> {
  const { store, hub } = ctx;
  const doc = store.getMessage(messageId);
  const meta = documentMeta(doc);
  if (!doc || !meta) throw new HttpError(404, 'document not found');
  if (isPdfMeta(meta)) throw new HttpError(400, `${meta.name} is a PDF: PDFs are read-only.`);
  const current = docVersion(meta);
  const base = input.base ?? current;
  if (!Number.isInteger(base) || base < 1 || base > current) throw new HttpError(400, `no version ${input.base}`);
  const stale = base !== current;
  const since = `${meta.name} changed since version ${base}: ${who(meta.editedBy)} saved version ${current}`;
  const conflict = (why: string) => new EditConflict(`${since}${why}`, { version: current, editedBy: meta.editedBy ?? null });

  let next: string;
  let rebased = false;
  if (input.restore !== undefined) {
    const from = versionText(ctx, doc, input.restore);
    if (from === null) throw new HttpError(404, `no version ${input.restore}`);
    // Restoring is a decision about the version on screen: a newer one would be thrown away unseen.
    if (stale) throw conflict('. Look at it before restoring an older one.');
    next = from;
  } else if (typeof input.content === 'string') {
    if (stale) throw conflict(', and saving the whole text would undo it.');
    next = input.content;
  } else if (Array.isArray(input.ops) && input.ops.length) {
    next = doc.content_md;
    input.ops.forEach((op, i) => {
      if (typeof op?.find !== 'string' || typeof op.replace !== 'string' || !op.find) throw new HttpError(400, 'each change needs the text to replace');
      let at = -1;
      // The editor's own offset, while it still points at its text (first op only: later ones shift).
      if (!stale && i === 0 && Number.isInteger(op.at) && next.startsWith(op.find, op.at!)) at = op.at!;
      else {
        at = next.indexOf(op.find);
        if (at >= 0 && next.indexOf(op.find, at + 1) >= 0) {
          if (stale) throw conflict(', and the passage you edited now occurs more than once.');
          throw new HttpError(400, `The text to replace occurs more than once in ${meta.name}; quote more of it.`);
        }
        if (at < 0) {
          if (stale) throw conflict(', and the passage you edited is no longer in it as it was.');
          throw new HttpError(400, `The text to replace is not in version ${current} of ${meta.name}; copy it exactly.`);
        }
      }
      rebased ||= stale;
      next = next.slice(0, at) + op.replace + next.slice(at + op.find.length);
    });
  } else throw new HttpError(400, 'nothing to save');

  next = next.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();
  if (!next.trim()) throw new HttpError(400, `${meta.name} cannot be empty`);
  if (next.length > MAX_DOCUMENT_CHARS) throw new HttpError(413, `${meta.name} is too large (over ${MAX_DOCUMENT_CHARS / 1_000_000} MB)`);
  if (next === doc.content_md) return { document: doc, version: current, previous: current, rebased: false, unchanged: true };

  const version = current + 1;
  const [before, after] = await Promise.all([blocksCached(doc.id, doc.content_md), blocksCached(doc.id, next)]).catch(() => {
    throw new HttpError(400, `${meta.name} could not be read as Markdown after this change`);
  });
  const threads = store.threadsOnMessage(doc.id);
  const { anchors, changed } = reanchor(threads, before, after, version);
  const now = Date.now();
  const by = { kind: input.by.kind, id: input.by.kind === 'agent' ? input.by.id : null };
  const newMeta: DocumentMeta = { ...describeDocument(meta.name, next), version, editedBy: by, editedAt: now, changed };
  store.saveDocVersion({
    message: doc,
    first:
      current === 1 && !store.getDocVersion(doc.id, 1)
        ? { version: 1, content_md: doc.content_md, author_kind: 'user', author_id: null, thread_id: null, restored_from: null, created_at: doc.created_at }
        : null,
    version: { version, content_md: next, author_kind: by.kind, author_id: by.id, thread_id: input.by.threadId ?? null, restored_from: input.restore ?? null, created_at: now },
    meta: newMeta,
    anchors: anchors.map((a) => a.row),
  });

  const updated = store.getMessage(doc.id)!;
  hub.thread(doc.thread_id, 'message.updated', serializeMessage(updated));
  const moved = anchors.filter((a) => a.moved);
  const notice = store.insertMessage({
    thread_id: doc.thread_id,
    author_kind: 'system',
    content_md: `${input.by.kind === 'agent' ? `@${input.by.id}` : 'You'} ${input.restore !== undefined ? `restored version ${input.restore} of` : 'edited'} ${meta.name} (version ${version})`,
    status: 'done',
    meta: {
      kind: 'document_edit',
      documentId: doc.id,
      name: meta.name,
      version,
      previous: current,
      by,
      threadId: input.by.threadId ?? null,
      restored: input.restore ?? null,
      rebased,
      threads: { changed: moved.filter((a) => a.row.anchor === 'changed' && a.fresh).length, removed: moved.filter((a) => a.row.anchor === 'removed' && a.fresh).length },
    },
  });
  hub.thread(doc.thread_id, 'message.created', serializeMessage(notice));
  for (const a of moved) {
    publishChildSummary(ctx, a.row.id);
    hub.thread(a.row.id, 'thread.passage', { id: a.row.id });
  }
  return { document: updated, version, previous: current, rebased, unchanged: false, notice };
}

/** The text of a version: from the history, or the message itself for an unedited document's version 1. */
export function versionText(ctx: AppContext, doc: MessageRow, version: number): string | null {
  const row = ctx.store.getDocVersion(doc.id, version);
  if (row) return row.content_md;
  return version === 1 && docVersion(documentMeta(doc)) === 1 ? doc.content_md : null;
}

/** A document's versions, oldest first; an unedited document has just version 1. */
export function listVersions(ctx: AppContext, doc: MessageRow) {
  const rows = ctx.store.listDocVersions(doc.id);
  const all: (Omit<DocVersionRow, 'content_md'> & { chars: number })[] = rows.length
    ? rows
    : [{ message_id: doc.id, version: 1, author_kind: 'user', author_id: null, thread_id: null, restored_from: null, created_at: doc.created_at, chars: doc.content_md.length }];
  return all.map((r) => ({
    version: r.version,
    by: { kind: r.author_kind, id: r.author_id },
    threadId: r.thread_id,
    restored: r.restored_from,
    createdAt: r.created_at,
    chars: r.chars,
  }));
}

interface Anchor {
  row: { id: string; block_index: number; block_end: number; anchor: ThreadRow['anchor']; anchor_version: number | null };
  /** Its place or state changed. */
  moved: boolean;
  /** This edit is what changed or removed its passage. */
  fresh: boolean;
}

/**
 * Where each thread on a document goes after an edit. The two versions' blocks are matched; a thread
 * whose blocks all survive, in one run, follows them. One whose blocks were rewritten moves to what
 * replaced them and is marked 'changed' (its quote keeps the text it was opened on). One whose blocks
 * are gone, or that would now share a block with another thread, is detached and marked 'removed':
 * never quietly moved onto a passage it was not about. A detached or changed thread whose original text
 * is back (a restore) is attached to it again, unmarked. Also returns the blocks the edit changed.
 */
export function reanchor(threads: ThreadRow[], before: string[], after: string[], version: number): { anchors: Anchor[]; changed: [number, number][] } {
  const pairs = matchSeq(before, after);
  const map = new Int32Array(before.length).fill(-1);
  const kept = new Uint8Array(after.length);
  for (const [i, j] of pairs) {
    map[i] = j;
    kept[j] = 1;
  }
  // The new blocks that took an unmatched old block's place: between its matched neighbours. A run of
  // old blocks replaced by as many new ones is taken block for block (paragraphs edited in place).
  const replacement = (i: number): [number, number] => {
    let p = i - 1;
    while (p >= 0 && map[p] < 0) p--;
    let q = i + 1;
    while (q < before.length && map[q] < 0) q++;
    const lo = p >= 0 ? map[p] + 1 : 0;
    const hi = q < before.length ? map[q] - 1 : after.length - 1;
    if (hi - lo === q - p - 2) return [lo + i - p - 1, lo + i - p - 1];
    return [lo, hi];
  };
  const textAt = (s: number, e: number) => after.slice(s, e + 1).join('\n\n');
  // Where a quote's exact text is in the new version (the one nearest `near`), e.g. after a restore.
  const findText = (text: string | null, near: number): [number, number] | null => {
    if (!text) return null;
    let best: [number, number] | null = null;
    for (let s = 0; s < after.length; s++) {
      if (!text.startsWith(after[s])) continue;
      let joined = after[s];
      let e = s;
      while (joined.length < text.length && e + 1 < after.length) joined += '\n\n' + after[++e];
      if (joined === text && (!best || Math.abs(s - near) < Math.abs(best[0] - near))) best = [s, e];
    }
    return best;
  };

  type Place = { t: ThreadRow; s: number; e: number; anchor: ThreadRow['anchor']; version: number | null };
  const placed: Place[] = [];
  const detached: ThreadRow[] = [];
  for (const t of threads) {
    const s0 = t.block_index ?? -1;
    const e0 = t.block_end ?? s0;
    const live = s0 >= 0 && e0 < before.length;
    const idx: number[] = [];
    let all = live;
    for (let i = s0; live && i <= e0; i++) {
      if (map[i] >= 0) idx.push(map[i]);
      else {
        all = false;
        const [lo, hi] = replacement(i);
        if (lo <= hi) idx.push(lo, hi);
      }
    }
    const s = idx.length ? Math.min(...idx) : Math.max(0, s0);
    const e = idx.length ? Math.max(...idx) : s;
    // Its own text first: where the quote is again, word for word, the thread is back on its passage.
    if (!(all && e - s === e0 - s0 && textAt(s, e) === t.block_text)) {
      const back = findText(t.block_text, s);
      if (back) {
        placed.push({ t, s: back[0], e: back[1], anchor: null, version: null });
        continue;
      }
    }
    if (!idx.length) {
      detached.push(t);
      continue;
    }
    const intact = all && e - s === e0 - s0;
    const original = textAt(s, e) === t.block_text;
    placed.push({ t, s, e, anchor: original ? null : intact ? t.anchor : 'changed', version: original ? null : intact ? t.anchor_version : version });
  }
  // A block belongs to one thread: the ones still on their own text go first.
  placed.sort((a, b) => Number(a.anchor !== null) - Number(b.anchor !== null) || a.s - b.s);
  const taken: Place[] = [];
  for (const p of placed) {
    if (taken.some((q) => q.s <= p.e && p.s <= q.e)) detached.push(p.t);
    else taken.push(p);
  }

  const anchors: Anchor[] = [];
  for (const p of taken) {
    const row = { id: p.t.id, block_index: p.s, block_end: p.e, anchor: p.anchor, anchor_version: p.version };
    const moved = row.block_index !== p.t.block_index || row.block_end !== p.t.block_end || row.anchor !== p.t.anchor || row.anchor_version !== p.t.anchor_version;
    anchors.push({ row, moved, fresh: moved && p.anchor === 'changed' && p.version === version });
  }
  detached.forEach((t, k) => {
    const was = t.anchor === 'removed';
    const row = { id: t.id, block_index: -(k + 1), block_end: -(k + 1), anchor: 'removed' as const, anchor_version: was ? t.anchor_version : version };
    anchors.push({ row, moved: row.block_index !== t.block_index || !was, fresh: !was });
  });

  const changed: [number, number][] = [];
  for (let j = 0; j < after.length; j++) {
    if (kept[j]) continue;
    const last = changed.at(-1);
    if (last && last[1] === j - 1) last[1] = j;
    else changed.push([j, j]);
  }
  return { anchors, changed };
}

// ---- agents: <document_edit> blocks in a reply ----

export interface AgentEdit {
  name: string | null;
  ops: EditOp[];
  content?: string;
}

/** A result shown with the agent's reply (meta.documentEdits). */
export interface AgentEditResult {
  name: string;
  documentId: string | null;
  status: 'applied' | 'unchanged' | 'failed';
  version?: number;
  previous?: number;
  rebased?: boolean;
  error?: string;
}

const EDIT_RE = /<document_edit\b([^>]*)>([\s\S]*?)<\/document_edit>/g;
const PAIR_RE = /<replace>([\s\S]*?)<\/replace>\s*<with>([\s\S]*?)<\/with>/g;
const CONTENT_RE = /<content>([\s\S]*?)<\/content>/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm;

/** The inside of a tag, without the line breaks that open and close it. */
const inner = (s: string) => s.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');

/**
 * The document edits in a reply (outside code fences, where an agent may be showing the syntax), and the
 * reply without them: the edit itself is shown as a result card, not as text.
 */
export function parseDocumentEdits(text: string): { text: string; edits: AgentEdit[] } {
  const fences: [number, number][] = [];
  for (const m of text.matchAll(FENCE_RE)) fences.push([m.index!, m.index! + m[0].length]);
  const edits: AgentEdit[] = [];
  const out = text.replace(EDIT_RE, (whole, attrs: string, body: string, at: number) => {
    if (fences.some(([s, e]) => s <= at && at < e)) return whole;
    const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1]?.trim() || null;
    const content = CONTENT_RE.exec(body);
    const ops = [...body.matchAll(PAIR_RE)].map((p) => ({ find: inner(p[1]), replace: inner(p[2]) }));
    edits.push(content ? { name, ops: [], content: inner(content[1]) } : { name, ops });
    return '';
  });
  return { text: edits.length ? out.replace(/\n{3,}/g, '\n\n').trim() : text, edits };
}

/** The documents an agent in this thread can edit: the passage's document first, then those shared in the conversation. */
export function editableDocuments(ctx: AppContext, thread: ThreadRow): MessageRow[] {
  const { store } = ctx;
  const out: MessageRow[] = [];
  const source = thread.parent_message_id ? store.getMessage(thread.parent_message_id) : undefined;
  // PDFs are read-only: never an agent's to edit.
  const editable = (m: MessageRow | undefined): m is MessageRow => !!documentMeta(m) && !isPdfMeta(documentMeta(m));
  if (editable(source)) out.push(source);
  const root = store.rootThread(thread.conversation_id);
  for (const m of store.listMessages(root.id).reverse()) if (editable(m) && m.id !== source?.id) out.push(m);
  return out;
}

/**
 * Applies an agent's edits, one document at a time. `known` is the version of each document the agent's
 * session had read, the base its edits are checked against.
 */
export async function applyAgentEdits(ctx: AppContext, thread: ThreadRow, agent: string, edits: AgentEdit[], known: Record<string, number>): Promise<AgentEditResult[]> {
  const docs = editableDocuments(ctx, thread);
  const results: AgentEditResult[] = [];
  for (const e of edits) {
    const doc = e.name ? docs.find((d) => documentMeta(d)!.name.toLowerCase() === e.name!.toLowerCase()) : docs.length === 1 || thread.parent_message_id === docs[0]?.id ? docs[0] : undefined;
    const name = doc ? documentMeta(doc)!.name : (e.name ?? 'the document');
    if (!doc) {
      const pdf = e.name && /\.pdf$/i.test(e.name);
      results.push({ name, documentId: null, status: 'failed', error: pdf ? `${e.name} is a PDF: PDFs are read-only.` : e.name ? `There is no document named ${e.name} here.` : 'Say which document to edit (name="…").' });
      continue;
    }
    if (!e.ops.length && e.content === undefined) {
      results.push({ name, documentId: doc.id, status: 'failed', error: 'The edit had no <replace>/<with> pair or <content>.' });
      continue;
    }
    try {
      const r = await editDocument(ctx, doc.id, {
        base: known[doc.id],
        ...(e.content !== undefined ? { content: e.content } : { ops: e.ops }),
        by: { kind: 'agent', id: agent, threadId: thread.id },
      });
      results.push({ name, documentId: doc.id, status: r.unchanged ? 'unchanged' : 'applied', version: r.version, previous: r.previous, rebased: r.rebased });
    } catch (err: any) {
      results.push({ name, documentId: doc.id, status: 'failed', error: err?.message ?? String(err) });
    }
  }
  return results;
}
