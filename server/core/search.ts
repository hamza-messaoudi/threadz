import type { DB } from '../db/migrate.ts';

export interface SearchQuery {
  terms: string[];
  channel?: string;
  agent?: string;
  fromMe?: boolean;
}

/** Splits filters (`in:#channel`, `from:@agent`, `from:me`) from free-text terms. Quotes keep phrases. */
export function parseSearch(q: string): SearchQuery {
  const out: SearchQuery = { terms: [] };
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = m[1];
    const word = m[2];
    if (phrase !== undefined) {
      if (phrase.trim()) out.terms.push(phrase.trim());
      continue;
    }
    const inM = /^in:#?(.+)$/i.exec(word);
    const fromM = /^from:@?(.+)$/i.exec(word);
    if (inM) out.channel = inM[1];
    else if (fromM) {
      if (fromM[1].toLowerCase() === 'me') out.fromMe = true;
      else out.agent = fromM[1];
    } else out.terms.push(word);
  }
  return out;
}

/** Every user term is quoted, so FTS syntax characters can never cause errors. The last one is a prefix. */
export function ftsMatch(terms: string[]): string {
  return terms.map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function searchMessages(db: DB, q: string, limit = 30) {
  const parsed = parseSearch(q);
  if (!parsed.terms.length) return [];
  const rows = db
    .prepare(
      `SELECT m.id, m.thread_id, t.conversation_id, c.name AS conversation_name, c.kind AS conversation_kind,
              t.parent_thread_id, m.author_kind, m.author_id, m.created_at,
              snippet(messages_fts, 0, char(1), char(2), '…', 14) AS snip
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       JOIN threads t ON t.id = m.thread_id
       JOIN conversations c ON c.id = t.conversation_id
       WHERE messages_fts MATCH @match
         AND (@channel IS NULL OR c.name = @channel COLLATE NOCASE)
         AND (@agent IS NULL OR (m.author_kind = 'agent' AND m.author_id = @agent COLLATE NOCASE))
         AND (@fromMe = 0 OR m.author_kind = 'user')
       ORDER BY bm25(messages_fts)
       LIMIT @limit`,
    )
    .all({ match: ftsMatch(parsed.terms), channel: parsed.channel ?? null, agent: parsed.agent ?? null, fromMe: parsed.fromMe ? 1 : 0, limit }) as any[];
  return rows.map((r) => ({
    messageId: r.id,
    threadId: r.thread_id,
    conversationId: r.conversation_id,
    conversationName: r.conversation_name,
    conversationKind: r.conversation_kind,
    inThread: !!r.parent_thread_id,
    authorKind: r.author_kind,
    authorId: r.author_id,
    createdAt: r.created_at,
    snippet: escapeHtml(r.snip).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'),
  }));
}
