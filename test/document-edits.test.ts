import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../server/context/diff.ts';
import { READER_MIN_CHARS } from '../server/context/documents.ts';
import { editDocument, parseDocumentEdits } from '../server/core/documents.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** A title, then numbered paragraphs: block i is paragraph i. */
const para = (i: number) => `Paragraph ${i} explains part ${i} of the platform in some detail, with enough words to read as a real passage.`;
function handbook(n: number, edit: (i: number) => string | null = para): string {
  const out = ['# Handbook', ''];
  for (let i = 1; i <= n; i++) {
    const p = edit(i);
    if (p !== null) out.push(p, '');
  }
  return out.join('\n').trimEnd();
}
const SMALL = handbook(6);
const LONG = handbook(260);

/** A reply that edits the document: FAKE_REPLY takes one line, with \n for line breaks. */
const editReply = (pairs: [string, string][], say = 'Done.', name = 'handbook.md') =>
  `FAKE_REPLY=${say}\\n\\n<document_edit name="${name}">\\n${pairs.map(([a, b]) => `<replace>\\n${a}\\n</replace>\\n<with>\\n${b}\\n</with>`).join('\\n')}\\n</document_edit>`;

async function setup() {
  const t = makeFakeApp({ 'agents/r.md': agentFile('r') });
  cleanup.push(() => t.ctx.close());
  const ch = await t.channel();
  const share = async (content: string, name = 'handbook.md') => (await t.call('POST', `/api/threads/${ch.rootThreadId}/documents`, { name, content })).body;
  const thread = async (messageId: string, block: number, end = block) => (await t.call('POST', '/api/threads', { message_id: messageId, block_index: block, block_end: end })).body.id as string;
  const ask = async (threadId: string, text: string, agent = 'r') => t.settled((await t.post(threadId, `@${agent} ${text}`, [{ kind: 'agent', id: agent, start: 0, end: agent.length + 1 }])).agentMessageIds[0]);
  const save = (id: string, body: unknown) => t.call('PATCH', `/api/documents/${id}`, body);
  const threadRow = (id: string) => t.ctx.store.getThread(id)!;
  const doc = (id: string) => t.message(id);
  const meta = (id: string) => JSON.parse(doc(id).meta!);
  const root = () => t.ctx.store.listMessages(ch.rootThreadId);
  return { t, ch, share, thread, ask, save, threadRow, doc, meta, root };
}

describe('the user edits a document', () => {
  it('saving the whole text makes version 2, keeps version 1, and notes the edit in the timeline', async () => {
    const { t, share, save, doc, meta, root } = await setup();
    const d = await share(SMALL);
    const next = SMALL.replace(para(3), 'Paragraph 3 now says something else.');
    const r = await save(d.id, { base: 1, content: next + '\r\n' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 2, rebased: false, unchanged: false });
    expect(doc(d.id).content_md).toBe(next);
    expect(meta(d.id)).toMatchObject({ kind: 'document', name: 'handbook.md', version: 2, editedBy: { kind: 'user', id: null }, changed: [[3, 3]] });

    const versions = (await t.call('GET', `/api/documents/${d.id}/versions`)).body;
    expect(versions.current).toBe(2);
    expect(versions.versions.map((v: any) => [v.version, v.by.kind])).toEqual([
      [1, 'user'],
      [2, 'user'],
    ]);
    expect((await t.call('GET', `/api/documents/${d.id}/versions/1`)).body.content).toBe(SMALL);

    const notice = root().at(-1)!;
    expect(notice.author_kind).toBe('system');
    expect(JSON.parse(notice.meta!)).toMatchObject({ kind: 'document_edit', documentId: d.id, version: 2, previous: 1, by: { kind: 'user' } });
    // Search finds the new text.
    expect((await t.call('GET', '/api/search?q=something')).body.length).toBe(1);
  });

  it('cancel: saving the text unchanged makes no version', async () => {
    const { share, save, meta, root } = await setup();
    const d = await share(SMALL);
    const r = await save(d.id, { base: 1, content: SMALL });
    expect(r.body).toMatchObject({ version: 1, unchanged: true });
    expect(meta(d.id).version).toBeUndefined();
    expect(root()).toHaveLength(1);
  });

  it('a section edit replaces its own text at its offset, even where the same text occurs twice', async () => {
    const { share, save, doc } = await setup();
    const twice = `${SMALL}\n\n${para(2)}`;
    const d = await share(twice);
    const at = twice.lastIndexOf(para(2));
    const r = await save(d.id, { base: 1, ops: [{ find: para(2), replace: 'The last one, rewritten.', at }] });
    expect(r.status).toBe(200);
    expect(doc(d.id).content_md).toBe(`${SMALL}\n\nThe last one, rewritten.`);
    // Without the offset the text is ambiguous.
    expect((await save(d.id, { base: 2, ops: [{ find: para(2).slice(0, 20) + ' explains part 2', replace: 'x' }] })).status).toBe(400);
  });

  it('refuses empty and unknown documents', async () => {
    const { t, share, save } = await setup();
    const d = await share(SMALL);
    expect((await save(d.id, { base: 1, content: '  \n' })).status).toBe(400);
    expect((await save(d.id, { base: 1 })).status).toBe(400);
    expect((await save('nope', { base: 1, content: 'x' })).status).toBe(404);
    const plain = await t.post(d.threadId, 'not a document');
    await t.settled(plain.agentMessageIds[0]);
    expect((await save(plain.message.id, { content: 'x' })).status).toBe(404);
  });
});

describe('restoring a version', () => {
  it('brings back an older text as a new version, and refuses to throw away one the user has not seen', async () => {
    const { t, share, save, doc, root } = await setup();
    const d = await share(SMALL);
    await save(d.id, { base: 1, content: SMALL.replace(para(1), 'One.') });
    await save(d.id, { base: 2, content: SMALL.replace(para(1), 'Two.') });
    expect((await t.call('POST', `/api/documents/${d.id}/restore`, { version: 1, base: 2 })).status).toBe(409);
    const r = await t.call('POST', `/api/documents/${d.id}/restore`, { version: 1, base: 3 });
    expect(r.body).toMatchObject({ version: 4 });
    expect(doc(d.id).content_md).toBe(SMALL);
    const versions = (await t.call('GET', `/api/documents/${d.id}/versions`)).body.versions;
    expect(versions.at(-1)).toMatchObject({ version: 4, restored: 1 });
    expect(root().at(-1)!.content_md).toBe('You restored version 1 of handbook.md (version 4)');
    expect((await t.call('POST', `/api/documents/${d.id}/restore`, { version: 9, base: 4 })).status).toBe(404);
  });
});

describe('threads on an edited document', () => {
  it('follow their paragraph, are marked when it changed, detached when it went, and come back with it', async () => {
    const { t, share, thread, save, threadRow } = await setup();
    const d = await share(SMALL);
    const two = await thread(d.id, 2);
    const five = await thread(d.id, 5);
    const six = await thread(d.id, 6);

    // A paragraph inserted above: every thread moves down one block, unmarked.
    let text = SMALL.replace(para(1), `${para(1)}\n\nA new paragraph.`);
    await save(d.id, { base: 1, content: text });
    expect(threadRow(two)).toMatchObject({ block_index: 3, block_end: 3, anchor: null });
    expect(threadRow(five)).toMatchObject({ block_index: 6, anchor: null });

    // Paragraph 5 rewritten: its thread stays on what replaced it, marked; its quote keeps the old text.
    text = text.replace(para(5), 'Paragraph five, rewritten.');
    await save(d.id, { base: 2, content: text });
    expect(threadRow(five)).toMatchObject({ block_index: 6, block_end: 6, anchor: 'changed', anchor_version: 3, block_text: para(5) });

    // Paragraph 2 deleted: its thread is detached, not moved onto a neighbour.
    text = text.replace(`${para(2)}\n\n`, '');
    await save(d.id, { base: 3, content: text });
    expect(threadRow(two).anchor).toBe('removed');
    expect(threadRow(two).block_index).toBeLessThan(0);
    expect(threadRow(six)).toMatchObject({ block_index: 6, anchor: null });
    const kids = (await t.call('GET', `/api/threads/${d.threadId}`)).body.childThreads;
    expect(kids.find((k: any) => k.id === two)).toMatchObject({ anchor: 'removed', anchorVersion: 4 });
    // A new thread can open where the detached one was, and never merges with it.
    expect((await t.call('POST', '/api/threads', { message_id: d.id, block_index: 2 })).status).toBe(201);

    // Restoring version 1 puts both paragraphs back, and their threads with them.
    await t.call('POST', `/api/documents/${d.id}/restore`, { version: 1, base: 4 });
    expect(threadRow(two)).toMatchObject({ block_index: 2, anchor: null });
    expect(threadRow(five)).toMatchObject({ block_index: 5, anchor: null });
  });

  it('adjacent paragraphs edited together keep a thread each, and a restore puts both back unmarked', async () => {
    const { t, share, thread, save, threadRow } = await setup();
    const d = await share(SMALL);
    const a = await thread(d.id, 5);
    const b = await thread(d.id, 6);
    await save(d.id, { base: 1, content: SMALL.replace(para(5), 'Five, edited.').replace(para(6), 'Six, edited.') });
    expect(threadRow(a)).toMatchObject({ block_index: 5, block_end: 5, anchor: 'changed' });
    expect(threadRow(b)).toMatchObject({ block_index: 6, block_end: 6, anchor: 'changed' });
    await t.call('POST', `/api/documents/${d.id}/restore`, { version: 1, base: 2 });
    expect(threadRow(a)).toMatchObject({ block_index: 5, anchor: null, anchor_version: null });
    expect(threadRow(b)).toMatchObject({ block_index: 6, anchor: null, anchor_version: null });
  });

  it('a thread whose paragraph merged into another thread’s is detached rather than sharing it', async () => {
    const { share, thread, save, threadRow } = await setup();
    const d = await share(SMALL);
    const a = await thread(d.id, 3);
    const b = await thread(d.id, 4);
    await save(d.id, { base: 1, content: SMALL.replace(`${para(3)}\n\n${para(4)}`, 'Paragraphs 3 and 4, merged into one.') });
    const rows = [threadRow(a), threadRow(b)];
    expect(rows.filter((r) => r.block_index === 3)).toHaveLength(1);
    expect(rows.filter((r) => r.anchor === 'removed')).toHaveLength(1);
  });
});

describe('agents edit documents from a thread', () => {
  it('an edit block in the reply makes a new version by the agent; the reply shows the result instead', async () => {
    const { t, share, thread, ask, doc, meta, root } = await setup();
    const d = await share(SMALL);
    const id = await thread(d.id, 3);
    const m = await ask(id, `tighten this ${editReply([[para(3), 'Paragraph 3, tightened.']], 'Tightened it.')}`);
    expect(m.status).toBe('done');
    expect(m.content_md).toBe('Tightened it.');
    expect(JSON.parse(m.meta!).documentEdits).toEqual([{ name: 'handbook.md', documentId: d.id, status: 'applied', version: 2, previous: 1, rebased: false }]);
    expect(doc(d.id).content_md).toBe(SMALL.replace(para(3), 'Paragraph 3, tightened.'));
    expect(meta(d.id)).toMatchObject({ version: 2, editedBy: { kind: 'agent', id: 'r' } });
    expect(JSON.parse(root().at(-1)!.meta!)).toMatchObject({ kind: 'document_edit', by: { kind: 'agent', id: 'r' }, threadId: id });
    const versions = (await t.call('GET', `/api/documents/${d.id}/versions`)).body.versions;
    expect(versions[1]).toMatchObject({ version: 2, by: { kind: 'agent', id: 'r' }, threadId: id });
    // The thread's own passage changed: it is marked, still on its paragraph.
    expect(t.ctx.store.getThread(id)).toMatchObject({ block_index: 3, anchor: 'changed' });

    // The agent wrote the new text, so its next turn does not get the document again.
    await ask(id, 'thanks');
    expect(t.calls()[1].stdin).not.toContain('<document_updated');
  });

  it('an edit that cannot apply is reported with the reply, and changes nothing', async () => {
    const { share, thread, ask, doc } = await setup();
    const d = await share(SMALL);
    const m = await ask(await thread(d.id, 1), `go ${editReply([['Not in the document.', 'x']])}`);
    expect(JSON.parse(m.meta!).documentEdits[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('not in version 1') });
    expect(doc(d.id).content_md).toBe(SMALL);
    const other = await ask(await thread(d.id, 2), `go ${editReply([[para(2), 'x']], 'ok', 'other.md')}`);
    expect(JSON.parse(other.meta!).documentEdits[0]).toMatchObject({ status: 'failed', error: 'There is no document named other.md here.' });
  });

  it('an agent in the main thread edits a document shared there, by name', async () => {
    const { ch, share, ask, doc } = await setup();
    const d = await share(SMALL);
    await share('# Other\n\nText.', 'other.md');
    await ask(ch.rootThreadId, `fix it ${editReply([[para(6), 'The end.']])}`);
    expect(doc(d.id).content_md.endsWith('The end.')).toBe(true);
  });
});

describe('agents see the current version on their next turn', () => {
  it('a short document comes again in full, once, and the cached prefix is not rewritten', async () => {
    const { t, share, thread, ask, save } = await setup();
    const d = await share(SMALL);
    const id = await thread(d.id, 2);
    const first = await ask(id, 'one');
    await save(d.id, { base: 1, content: SMALL.replace(para(4), 'Paragraph 4, edited by the user.') });
    const second = await ask(id, 'two');
    const call = t.calls()[1];
    // Resumed, not reseeded: the update is appended after what the session has read.
    expect(call.argv.slice(-2)).toEqual(['--resume', first.session_id]);
    expect(call.stdin.indexOf('<document_updated name="handbook.md" version="2" previous="1">')).toBe(0);
    expect(call.stdin).toContain('the user edited "handbook.md" since you read version 1');
    expect(call.stdin).toContain('<document name="handbook.md" version="2">');
    expect(call.stdin).toContain('Paragraph 4, edited by the user.');
    expect(JSON.parse(second.markers!)).toContain('read handbook.md version 2');
    // Nothing changed since: nothing is sent again.
    await ask(id, 'three');
    expect(t.calls()[2].stdin).not.toContain('<document');
  });

  it('a long document gets the changes as a diff, and a new thread reads the new version once', async () => {
    const { t, share, thread, ask, save } = await setup();
    expect(LONG.length).toBeGreaterThan(READER_MIN_CHARS);
    const d = await share(LONG);
    const a = await ask(await thread(d.id, 10), 'one');
    expect(t.calls()).toHaveLength(2); // reader + thread
    await save(d.id, { base: 1, content: LONG.replace(para(120), 'Paragraph 120 was replaced.') });
    await ask(a.thread_id, 'two');
    const upd = t.calls()[2].stdin;
    expect(upd).toContain('as a unified diff against the version you read');
    expect(upd).toContain(`-${para(120)}\n+Paragraph 120 was replaced.`);
    expect(upd).not.toContain(para(1));
    expect(upd.length).toBeLessThan(2000);

    // The reader read version 1: a new thread does not fork it, a new reader reads version 2.
    await ask(await thread(d.id, 200), 'three');
    const [read, fork] = t.calls().slice(3);
    expect(read.stdin).toContain('<document_ready>');
    expect(read.stdin).toContain('Paragraph 120 was replaced.');
    expect(fork.argv.slice(-3)).toEqual(['--resume', read.sessionId, '--fork-session']);
    expect(t.ctx.store.getReaderSession(d.id, 'r', a.cwd!)!.version).toBe(2);
  });

  it('a thread forked from a main session that read an older version is told what changed', async () => {
    const { t, ch, share, thread, ask, save } = await setup();
    const d = await share(SMALL);
    await ask(ch.rootThreadId, 'read it');
    await save(d.id, { base: 1, content: SMALL.replace(para(6), 'Paragraph 6, new.') });
    await ask(await thread(d.id, 6), 'about this');
    const fork = t.calls()[1];
    expect(fork.argv).toContain('--fork-session');
    expect(fork.stdin.indexOf('<document_updated')).toBe(0);
    expect(fork.stdin).toContain('Paragraph 6, new.');
  });

  it('a session from before documents could change learns how to edit, once', async () => {
    const { t, share, thread, ask } = await setup();
    const d = await share(SMALL);
    const id = await thread(d.id, 1);
    const m = await ask(id, 'one');
    t.ctx.store.db.prepare(`UPDATE agent_sessions SET doc_versions = NULL`).run();
    await ask(id, 'two');
    expect(t.calls()[1].stdin.startsWith('<document_editing>')).toBe(true);
    await ask(id, 'three');
    expect(t.calls()[2].stdin).not.toContain('<document_editing>');
    expect(m.status).toBe('done');
  });

  it('a paragraph thread is told its passage changed', async () => {
    const { t, share, thread, ask, save } = await setup();
    const d = await share(SMALL);
    const id = await thread(d.id, 3);
    await ask(id, 'one');
    await save(d.id, { base: 1, content: SMALL.replace(`${para(3)}\n\n`, '') });
    await ask(id, 'two');
    expect(t.calls()[1].stdin).toContain('The passage this side thread is about is no longer in the document as it was quoted');
  });
});

describe('racing edits', () => {
  it('a user save against a version an agent replaced meanwhile is refused with who saved what', async () => {
    const { share, thread, ask, save, doc } = await setup();
    const d = await share(SMALL);
    await ask(await thread(d.id, 2), `edit ${editReply([[para(2), 'The agent’s paragraph 2.']])}`);
    // The user had version 1 open and saves the whole text.
    const r = await save(d.id, { base: 1, content: SMALL.replace(para(5), 'The user’s paragraph 5.') });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('handbook.md changed since version 1: @r saved version 2, and saving the whole text would undo it.');
    expect(r.body.current).toEqual({ version: 2, editedBy: { kind: 'agent', id: 'r' } });
    expect(doc(d.id).content_md).toContain('The agent’s paragraph 2.');
    // A section edit elsewhere still applies on top, and says so.
    const s = await save(d.id, { base: 1, ops: [{ find: para(5), replace: 'The user’s paragraph 5.', at: SMALL.indexOf(para(5)) }] });
    expect(s.body).toMatchObject({ version: 3, rebased: true });
    expect(doc(d.id).content_md).toContain('The agent’s paragraph 2.');
    expect(doc(d.id).content_md).toContain('The user’s paragraph 5.');
    // One on the passage the agent rewrote conflicts.
    expect((await save(d.id, { base: 1, ops: [{ find: para(2), replace: 'x' }] })).status).toBe(409);
  });

  it('edits running at the same moment apply one after the other, neither lost', async () => {
    const { t, share, doc } = await setup();
    const d = await share(SMALL);
    const results = await Promise.allSettled([
      editDocument(t.ctx, d.id, { base: 1, ops: [{ find: para(1), replace: 'First.' }], by: { kind: 'agent', id: 'r' } }),
      editDocument(t.ctx, d.id, { base: 1, content: SMALL.replace(para(6), 'Whole.'), by: { kind: 'user', id: null } }),
      editDocument(t.ctx, d.id, { base: 1, ops: [{ find: para(4), replace: 'Fourth.' }], by: { kind: 'user', id: null } }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason.status).toBe(409);
    const text = doc(d.id).content_md;
    expect(text).toContain('First.');
    expect(text).toContain('Fourth.');
    expect(JSON.parse(doc(d.id).meta!).version).toBe(3);
  });

  it('an agent’s whole-text rewrite of a version the user replaced mid-turn is refused', async () => {
    const { t, share, thread, save, doc } = await setup();
    const d = await share(SMALL);
    const id = await thread(d.id, 1);
    const r = await t.post(id, `@r FAKE_DELAY=400\nFAKE_REPLY=Rewritten.\\n<document_edit name="handbook.md">\\n<content>\\n# Handbook\\n\\nAll new.\\n</content>\\n</document_edit>`, [{ kind: 'agent', id: 'r', start: 0, end: 2 }]);
    await new Promise((res) => setTimeout(res, 150));
    await save(d.id, { base: 1, content: SMALL.replace(para(3), 'Meanwhile.') });
    const m = await t.settled(r.agentMessageIds[0]);
    expect(JSON.parse(m.meta!).documentEdits[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('changed since version 1: you saved version 2') });
    expect(doc(d.id).content_md).toContain('Meanwhile.');
  });
});

describe('parsing edit blocks', () => {
  it('reads replace pairs and whole rewrites, and leaves examples in code fences alone', () => {
    const text = [
      'Here is how:',
      '```',
      '<document_edit name="x.md"><content>no</content></document_edit>',
      '```',
      '<document_edit name="a.md">',
      '<replace>',
      'old one',
      '</replace>',
      '<with>',
      'new one',
      '</with>',
      '<replace>gone</replace><with></with>',
      '</document_edit>',
      '',
      '<document_edit><content>',
      '# All',
      '</content></document_edit>',
      'Done.',
    ].join('\n');
    const r = parseDocumentEdits(text);
    expect(r.edits).toEqual([
      { name: 'a.md', ops: [{ find: 'old one', replace: 'new one' }, { find: 'gone', replace: '' }] },
      { name: null, ops: [], content: '# All' },
    ]);
    expect(r.text).toBe('Here is how:\n```\n<document_edit name="x.md"><content>no</content></document_edit>\n```\n\nDone.');
  });
});

describe('unified diff', () => {
  it('shows changed lines with context and line numbers of both sides', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
    expect(unifiedDiff(a, b, 1)).toBe(['@@ -3,3 +3,3 @@', ' c', '-d', '+D', ' e', '@@ -8,1 +8,2 @@', ' h', '+i'].join('\n'));
    expect(unifiedDiff(a, a)).toBe('');
  });
});
