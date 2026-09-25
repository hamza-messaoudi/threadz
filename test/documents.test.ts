import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READER_MIN_CHARS } from '../server/context/documents.ts';
import { renderSeed, SEED_MAX_CHARS } from '../server/context/seed.ts';
import type { MessageRow } from '../server/db/queries.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** A document: a title, then numbered paragraphs (block i is paragraph i). */
function handbook(paragraphs: number): string {
  const out = ['# Handbook', ''];
  for (let i = 1; i <= paragraphs; i++) out.push(`Paragraph ${i} explains part ${i} of the platform in some detail, with enough words to read as a real passage.`, '');
  return out.join('\n').trimEnd();
}
const SMALL = handbook(6);
const LONG = handbook(260);

async function setup() {
  const t = makeFakeApp({ 'agents/r.md': agentFile('r') });
  cleanup.push(() => t.ctx.close());
  const ch = await t.channel();
  const share = async (content: string, name = 'handbook.md', threadId = ch.rootThreadId) => t.call('POST', `/api/threads/${threadId}/documents`, { name, content });
  const thread = async (messageId: string, block: number) => (await t.call('POST', '/api/threads', { message_id: messageId, block_index: block })).body.id as string;
  const ask = async (threadId: string, text: string, agent = 'r') => t.settled((await t.post(threadId, `@${agent} ${text}`, [{ kind: 'agent', id: agent, start: 0, end: agent.length + 1 }])).agentMessageIds[0]);
  return { t, ch, share, thread, ask };
}

const sessionsFile = (state: string) => path.join(state, 'sessions.json');

describe('document ingestion', () => {
  it('shares a Markdown document as one finished message that no agent answers', async () => {
    const { t, ch, share, ask } = await setup();
    await ask(ch.rootThreadId, 'hello'); // an agent has replied, so an untagged message would go to it
    const res = await share('﻿# Handbook\r\n\r\nFirst part.\r\n\r\nSecond part.\r\n', 'docs/handbook.md');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ authorKind: 'user', status: 'done', content: '# Handbook\n\nFirst part.\n\nSecond part.' });
    expect(res.body.meta).toEqual({ kind: 'document', name: 'handbook.md', title: 'Handbook', words: 6 });
    await new Promise((r) => setTimeout(r, 150));
    expect(t.calls()).toHaveLength(1);
    const main = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body;
    expect(main.messages.at(-1).meta.kind).toBe('document');
  });

  it('rejects other formats, empty and oversized documents, and side threads', async () => {
    const { t, share, thread } = await setup();
    expect((await share('# x', 'spec.pdf')).status).toBe(400);
    expect((await share('# x', 'spec')).status).toBe(400);
    expect((await share(' \n\n ')).status).toBe(400);
    expect((await share('x'.repeat(2_000_001))).status).toBe(413);
    const doc = (await share(SMALL)).body;
    const side = await thread(doc.id, 1);
    expect((await share(SMALL, 'again.md', side)).status).toBe(400);
    expect((await t.call('POST', '/api/threads/nope/documents', { name: 'a.md', content: 'a' })).status).toBe(404);
  });

  it('names a new chat after the document', async () => {
    const { t } = await setup();
    const chat = (await t.call('POST', '/api/conversations', { kind: 'chat' })).body;
    await t.call('POST', `/api/threads/${chat.rootThreadId}/documents`, { name: 'notes.md', content: '# Release plan for Q4\n\nText.' });
    expect(t.ctx.store.getConversation(chat.id)!.name).toBe('Release plan for Q4');
  });

  it('threads start on the document’s paragraphs, and the thread does not ship the whole document back', async () => {
    const { t, share, thread } = await setup();
    const doc = (await share(SMALL)).body;
    const id = await thread(doc.id, 3);
    expect(t.ctx.store.getThread(id)!.block_text).toBe('Paragraph 3 explains part 3 of the platform in some detail, with enough words to read as a real passage.');
    const data = (await t.call('GET', `/api/threads/${id}`)).body;
    expect(data.sourceMessage.meta.name).toBe('handbook.md');
    expect(data.sourceMessage.content).toBe('');
  });
});

describe('document context in side threads', () => {
  it('a thread on a paragraph gives its agent the whole document, first in the prompt, then only the new turn', async () => {
    const { t, share, thread, ask } = await setup();
    const doc = (await share(SMALL)).body;
    const id = await thread(doc.id, 3);
    const first = await ask(id, 'what does this rely on?');
    const call = t.calls()[0];
    expect(call.argv).not.toContain('--resume');
    // Every paragraph, not only the anchored one.
    for (let i = 1; i <= 6; i++) expect(call.stdin).toContain(`Paragraph ${i} explains part ${i}`);
    // Document, then the anchor, then the question: the document is the stable start of the session.
    const at = (s: string) => call.stdin.indexOf(s);
    expect(at('<shared_documents>')).toBe(0);
    expect(at('<document name="handbook.md">')).toBeLessThan(at('<thread_context>'));
    expect(at('<thread_context>')).toBeLessThan(at('what does this rely on?'));
    expect(call.stdin).toContain('of the document "handbook.md" they shared earlier');
    expect(call.stdin).toContain('> Paragraph 3 explains');

    // The follow-up resumes the thread's session and does not send the document again.
    await ask(id, 'and paragraph 6?');
    const next = t.calls()[1];
    expect(next.argv.slice(-2)).toEqual(['--resume', first.session_id]);
    expect(next.stdin).not.toContain('Paragraph 1 explains');
  });

  it('an untagged question about a passage goes to @claude when nobody has answered yet', async () => {
    const { t, share, thread } = await setup();
    const doc = (await share(SMALL)).body;
    const id = await thread(doc.id, 2);
    const r = await t.post(id, 'summarise the whole document');
    const m = await t.settled(r.agentMessageIds[0]);
    expect(m.author_id).toBe('claude');
    expect(t.calls()[0].stdin).toContain('Paragraph 6 explains');
  });

  it('forks the main session when it has read the document already', async () => {
    const { t, ch, share, thread, ask } = await setup();
    const doc = (await share(LONG)).body;
    const main = await ask(ch.rootThreadId, 'summarise the handbook');
    expect(t.calls()[0].stdin).toContain('Paragraph 260 explains');
    await ask(await thread(doc.id, 100), 'why?');
    const fork = t.calls()[1];
    expect(fork.argv.slice(-3)).toEqual(['--resume', main.session_id, '--fork-session']);
    expect(fork.stdin).not.toContain('Paragraph 1 explains');
    expect(fork.stdin).toContain('> Paragraph 100 explains');
    expect(t.ctx.store.getReaderSession(doc.id, 'r', main.cwd!)).toBeUndefined();
  });

  it('a long document is read once per agent; every thread on it forks that reader', async () => {
    const { t, share, thread, ask } = await setup();
    expect(LONG.length).toBeGreaterThan(READER_MIN_CHARS);
    const doc = (await share(LONG)).body;

    const a = await ask(await thread(doc.id, 5), 'what is part 5 for?');
    const [read, forkA] = t.calls();
    // The reader turn: the whole document, then a note that asks for nothing but an acknowledgement.
    expect(read.argv).not.toContain('--resume');
    expect(read.stdin).toContain('Paragraph 1 explains');
    expect(read.stdin).toContain('Paragraph 260 explains');
    expect(read.stdin.indexOf('<shared_documents>')).toBe(0);
    expect(read.stdin).toContain('<document_ready>');
    expect(read.stdin).not.toContain('what is part 5 for?');
    const reader = t.ctx.store.getReaderSession(doc.id, 'r', a.cwd!)!;
    expect(reader.claude_session_id).toBe(read.sessionId);
    // The thread forks it: its own prompt has the passage and the question, not the document.
    expect(forkA.argv.slice(-3)).toEqual(['--resume', reader.claude_session_id, '--fork-session']);
    expect(forkA.stdin).not.toContain('Paragraph 1 explains');
    expect(forkA.stdin).toMatch(/^<thread_context>\nThe user opened a side thread on this passage of the document "handbook.md"/);
    expect(forkA.stdin).toContain('what is part 5 for?');
    expect(JSON.parse(a.markers!)).toEqual(['read handbook.md once for all its threads']);
    expect(JSON.parse(a.usage!).reader.cache_creation_input_tokens).toBe(20000);

    // A second thread: one call, forked from the same reader.
    const b = await ask(await thread(doc.id, 200), 'and part 200?');
    expect(t.calls()).toHaveLength(3);
    expect(t.calls()[2].argv.slice(-3)).toEqual(['--resume', reader.claude_session_id, '--fork-session']);
    expect(t.calls()[2].stdin).not.toContain('Paragraph 1 explains');
    expect(JSON.parse(b.markers!)).toEqual(['handbook.md already read, session forked']);

    // Follow-ups resume each thread's own session.
    await ask(a.thread_id, 'more');
    expect(t.calls()[3].argv.slice(-2)).toEqual(['--resume', a.session_id]);
    expect(t.calls()[3].stdin).not.toContain('Paragraph 1 explains');
  });

  it('a reader made after earlier talk forks the main session and adds the document to it', async () => {
    const { t, ch, share, thread, ask } = await setup();
    const main = await ask(ch.rootThreadId, 'we are about to review a handbook');
    const doc = (await share(LONG)).body;
    await ask(await thread(doc.id, 9), 'context?');
    const read = t.calls()[1];
    expect(read.argv.slice(-3)).toEqual(['--resume', main.session_id, '--fork-session']);
    expect(read.stdin).toMatch(/^<thread_update>\n\[you [^\]]+\] shared the document "handbook.md":\n<document name="handbook.md">\n# Handbook/);
    expect(read.stdin).toContain('Paragraph 260 explains');
    // The main session itself is untouched: its next turn still carries the document, once.
    await ask(ch.rootThreadId, 'thoughts?');
    const next = t.calls()[3];
    expect(next.argv.slice(-2)).toEqual(['--resume', main.session_id]);
    expect(next.stdin).toContain('Paragraph 260 explains');
  });

  it('reads the document again when the reader’s transcript is gone', async () => {
    const { t, share, thread, ask } = await setup();
    const state = t.state;
    const doc = (await share(LONG)).body;
    const a = await ask(await thread(doc.id, 5), 'one');
    const reader = t.ctx.store.getReaderSession(doc.id, 'r', a.cwd!)!.claude_session_id;
    const known = JSON.parse(fs.readFileSync(sessionsFile(state), 'utf8')) as string[];
    fs.writeFileSync(sessionsFile(state), JSON.stringify(known.filter((s) => s !== reader)));

    const b = await ask(await thread(doc.id, 6), 'two');
    expect(b.status).toBe('done');
    const calls = t.calls().slice(2);
    expect(calls[0].error).toBe('missing');
    expect(calls[1].stdin).toContain('<document_ready>');
    expect(calls[2].argv.slice(-3)).toEqual(['--resume', calls[1].sessionId, '--fork-session']);
    expect(t.ctx.store.getReaderSession(doc.id, 'r', a.cwd!)!.claude_session_id).toBe(calls[1].sessionId);
  });
});

describe('seeds with documents', () => {
  const row = (i: number, content: string, meta?: unknown): MessageRow => ({
    id: String(i).padStart(4, '0'),
    thread_id: 't',
    author_kind: 'user',
    author_id: null,
    content_md: content,
    tool_events: null,
    status: 'done',
    error: null,
    usage: null,
    run_id: null,
    done_seq: i,
    created_at: Date.now(),
    cwd: null,
    session_id: null,
    markers: null,
    mentions: null,
    meta: meta ? JSON.stringify(meta) : null,
  });

  it('keeps a document whole and first, outside the history limits', () => {
    const doc = row(2, LONG, { kind: 'document', name: 'handbook.md', title: 'Handbook', words: 1 });
    const chatter = Array.from({ length: 80 }, (_, i) => row(i + 3, `message ${i} `.repeat(60)));
    const seed = renderSeed([row(1, 'before the document'), doc, ...chatter], 'r');
    expect(chatter.map((m) => m.content_md.length).reduce((a, b) => a + b)).toBeGreaterThan(SEED_MAX_CHARS);
    expect(seed.text.startsWith('<shared_documents>\nThe user shared this document in the conversation.')).toBe(true);
    expect(seed.text).toContain(`<document name="handbook.md">\n${LONG}\n</document>`);
    expect(seed.text).not.toContain('before the document'); // the history was cut, the document was not
    expect(seed.included).toContain(doc);
    // The same document renders byte-identically on any day, so a reseeded prefix matches.
    const later = renderSeed([doc], 'r', Date.now() + 5 * 86_400_000).text;
    expect(later.slice(0, later.indexOf('</shared_documents>'))).toBe(seed.text.slice(0, seed.text.indexOf('</shared_documents>')));
  });
});
