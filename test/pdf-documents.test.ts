import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { READER_MIN_CHARS } from '../server/context/documents.ts';
import { extractPdf } from '../server/context/pdf.ts';
import { pageSpan, pdfBlocks, pdfText, type PdfLayout } from '../shared/pdf.ts';
import { agentFile, makeFakeApp, PORT } from './helpers.ts';
import { makePdf, reportPdf } from './pdf-fixture.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

async function setup() {
  const t = makeFakeApp({ 'agents/r.md': agentFile('r') });
  cleanup.push(() => t.ctx.close());
  const ch = await t.channel();
  const cookie = `agent_chat_token=${t.ctx.token}`;
  const raw = (url: string, init: RequestInit = {}) =>
    t.app.request(url, { ...init, headers: { host: `127.0.0.1:${PORT}`, cookie, ...(init.headers as Record<string, string>) } });
  const sharePdf = async (bytes: Buffer, name = 'report.pdf', threadId = ch.rootThreadId) => {
    const res = await raw(`/api/threads/${threadId}/documents?name=${encodeURIComponent(name)}`, { method: 'POST', body: new Uint8Array(bytes), headers: { 'content-type': 'application/pdf' } });
    return { status: res.status, body: (await res.json()) as any };
  };
  const thread = async (messageId: string, block: number, end = block) => (await t.call('POST', '/api/threads', { message_id: messageId, block_index: block, block_end: end })).body.id as string;
  const ask = async (threadId: string, text: string, agent = 'r') => t.settled((await t.post(threadId, `@${agent} ${text}`, [{ kind: 'agent', id: agent, start: 0, end: agent.length + 1 }])).agentMessageIds[0]);
  return { t, ch, raw, sharePdf, thread, ask };
}

describe('PDF text', () => {
  it('writes pages as markers and paragraphs, and reads the blocks back with their pages', () => {
    const text = pdfText([['Title', 'First paragraph.'], [], ['[Page 9] is not a marker here', 'Last.']]);
    expect(text).toBe('[Page 1]\n\nTitle\n\nFirst paragraph.\n\n[Page 2]\n\n[Page 3]\n\n[Page 9] is not a marker here\n\nLast.');
    expect(pdfBlocks(text)).toEqual([
      { page: 1, text: 'Title' },
      { page: 1, text: 'First paragraph.' },
      { page: 3, text: '[Page 9] is not a marker here' },
      { page: 3, text: 'Last.' },
    ]);
    expect(pageSpan(4)).toBe('page 4');
    expect(pageSpan(4, 5)).toBe('pages 4–5');
  });

  it('extracts paragraphs, headings, list items and a layout that matches the text block for block', async () => {
    const pdf = await extractPdf(new Uint8Array(reportPdf(5)));
    const blocks = pdfBlocks(pdf.text);
    expect(pdf.pages).toBe(5);
    expect(pdf.title).toBe('Platform report');
    expect(pdf.scanned).toBe(false);
    // Page 2: its heading, three paragraphs of wrapped lines each joined into one, two list items, the page number.
    const page2 = blocks.filter((b) => b.page === 2).map((b) => b.text);
    expect(page2[0]).toBe('1.2 Section on page 2');
    expect(page2[1]).toMatch(/^Page 2 opens here\. .+\.$/);
    expect(page2.filter((t) => t.startsWith('• '))).toHaveLength(2);
    expect(page2.at(-2)).toMatch(/Page 2 ends here\.$/);
    expect(page2.at(-1)).toBe('2');
    // One layout paragraph per block, numbered on from page to page.
    let next = 0;
    for (const p of pdf.layout.pages) {
      expect(p.first).toBe(next);
      next += p.paras.length;
      for (const [a, z, x0, y0, x1, y1] of p.paras) {
        expect(z).toBeGreaterThan(a);
        expect(x1).toBeGreaterThan(x0);
        expect(y1).toBeGreaterThan(y0);
      }
    }
    expect(next).toBe(blocks.length);
    // The outline gives the contents, each entry at its heading's block.
    expect(pdf.layout.contents).toBe('outline');
    for (const h of pdf.layout.headings) expect(blocks[h.index].text).toBe(h.text);
    expect(pdf.layout.headings.map((h) => h.level)).toEqual([1, 2, 2, 2, 2, 1, 2]);
  });

  it('finds headings by type size without an outline, and falls back to pages', async () => {
    const byType = await extractPdf(new Uint8Array(reportPdf(5, { outline: false })));
    expect(byType.layout.contents).toBe('headings');
    expect(byType.layout.headings[0]).toMatchObject({ index: 0, level: 1, text: 'Platform report', page: 1 });
    expect(byType.layout.headings.find((h) => h.text === '1.2 Section on page 2')?.level).toBe(2);

    const plain = makePdf({ pages: [1, 2, 3].map((n) => ({ blocks: [{ kind: 'p' as const, text: `Only body text on page ${n}.` }] })) });
    const pages = await extractPdf(new Uint8Array(plain));
    expect(pages.layout.contents).toBe('pages');
    expect(pages.layout.headings.map((h) => h.text)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('flags a scan: pages with no text layer', async () => {
    const scan = await extractPdf(new Uint8Array(makePdf({ pages: [{ scanned: true }, { scanned: true }, { blocks: [{ kind: 'p', text: 'Appendix.' }] }] })));
    expect(scan.scanned).toBe(true);
    expect(scan.text).toBe('[Page 1]\n\n[Page 2]\n\n[Page 3]\n\nAppendix.\n\n3');
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(extractPdf(new Uint8Array(Buffer.from('just text')))).rejects.toThrow('could not be read as a PDF');
  });
});

describe('PDF ingestion', () => {
  it('shares a PDF as one finished document message, keeps the file and layout, and asks nobody', async () => {
    const { t, ch, raw, sharePdf } = await setup();
    const bytes = reportPdf(3);
    const res = await sharePdf(bytes, 'docs/report.pdf');
    expect(res.status).toBe(201);
    const { meta, content } = res.body;
    expect(meta).toMatchObject({ kind: 'document', format: 'pdf', name: 'report.pdf', title: 'Platform report', pages: 3, bytes: bytes.length });
    expect(meta.file).toMatch(/^[0-9a-f]{64}\.pdf$/);
    expect(meta.layout).toBe(meta.file.replace('.pdf', '.l1.json'));
    expect(meta.scanned).toBeUndefined();
    expect(content.startsWith('[Page 1]\n\nPlatform report\n\n1.1 Section on page 1\n\nPage 1 opens here.')).toBe(true);
    expect(fs.readFileSync(path.join(t.ctx.filesDir(), meta.file)).equals(bytes)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.calls()).toHaveLength(0);
    const main = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body;
    expect(main.messages.at(-1).meta.format).toBe('pdf');

    // The file and layout never change under their names: cached for good, 304 when asked again.
    const file = await raw(`/api/files/${meta.file}?name=report.pdf`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(file.headers.get('content-disposition')).toBe('inline; filename="report.pdf"');
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    const again = await raw(`/api/files/${meta.file}`, { headers: { 'if-none-match': file.headers.get('etag')! } });
    expect(again.status).toBe(304);
    const layout = (await (await raw(`/api/files/${meta.layout}`)).json()) as PdfLayout;
    expect(layout.pages).toHaveLength(3);
    expect(layout.pages.reduce((a, p) => a + p.paras.length, 0)).toBe(pdfBlocks(content).length);
    expect((await raw('/api/files/..%2Fagent-chat.db')).status).toBe(404);
    expect((await raw(`/api/files/${'0'.repeat(64)}.pdf`)).status).toBe(404);

    // pdf.js's own data for the renderer, by version.
    const { pdfjsVersion } = await import('../server/context/pdf.ts');
    const font = await raw(`/api/pdfjs/${pdfjsVersion}/standard_fonts/FoxitSerif.pfb`);
    expect(font.status).toBe(200);
    expect(font.headers.get('cache-control')).toContain('immutable');
    expect((await raw(`/api/pdfjs/${pdfjsVersion}/../package.json`)).status).toBe(404);
    expect((await raw(`/api/pdfjs/0.0.1/standard_fonts/FoxitSerif.pfb`)).status).toBe(404);
  });

  it('rejects files that are not PDFs, oversized ones, and side threads; names a new chat after the PDF', async () => {
    const { t, sharePdf, thread } = await setup();
    expect((await sharePdf(Buffer.from('not a pdf'))).body.error).toBe('report.pdf could not be read as a PDF');
    expect((await sharePdf(reportPdf(1), 'report.txt')).status).toBe(400);
    expect((await sharePdf(Buffer.alloc(0))).status).toBe(400);
    const doc = (await sharePdf(reportPdf(2))).body;
    expect((await sharePdf(reportPdf(1), 'again.pdf', await thread(doc.id, 1))).status).toBe(400);

    const chat = (await t.call('POST', '/api/conversations', { kind: 'chat' })).body;
    await sharePdf(reportPdf(1, { title: 'Q4 launch review' }), 'q4.pdf', chat.rootThreadId);
    expect(t.ctx.store.getConversation(chat.id)!.name).toBe('Q4 launch review');
  });

  it('keeps a scan, flagged, and points agents at the file', async () => {
    const { sharePdf } = await setup();
    const res = await sharePdf(makePdf({ pages: [{ scanned: true }, { scanned: true }] }), 'scan.pdf');
    expect(res.status).toBe(201);
    expect(res.body.meta.scanned).toBe(true);
    expect(res.body.content).toBe('[Page 1]\n\n[Page 2]');
  });
});

describe('threads on a PDF', () => {
  it('anchor to paragraphs, quote their text, and span several across a page break', async () => {
    const { t, sharePdf, thread } = await setup();
    const doc = (await sharePdf(reportPdf(3))).body;
    const blocks = pdfBlocks(doc.content);
    const i = blocks.findIndex((b) => b.text.startsWith('Page 2 opens here.'));
    const one = await thread(doc.id, i);
    expect(t.ctx.store.getThread(one)!.block_text).toBe(blocks[i].text);
    // The last paragraphs of page 2 and the first of page 3, as one passage.
    const end = blocks.findIndex((b) => b.page === 3) + 1;
    const span = await thread(doc.id, end - 3, end);
    expect(t.ctx.store.getThread(span)!.block_text).toBe(blocks.slice(end - 3, end + 1).map((b) => b.text).join('\n\n'));
    expect((await t.call('POST', '/api/threads', { message_id: doc.id, block_index: blocks.length })).status).toBe(400);
    const data = (await t.call('GET', `/api/threads/${one}`)).body;
    expect(data.sourceMessage.meta.format).toBe('pdf');
    expect(data.sourceMessage.content).toBe('');
  });

  it('give the agent the whole PDF, with pages, first in the prompt; then the passage and its page', async () => {
    const { t, sharePdf, thread, ask } = await setup();
    const doc = (await sharePdf(reportPdf(3))).body;
    expect(doc.content.length).toBeLessThan(READER_MIN_CHARS);
    const blocks = pdfBlocks(doc.content);
    const i = blocks.findIndex((b) => b.text.startsWith('Page 2 opens here.'));
    const first = await ask(await thread(doc.id, i), 'what does this rely on?');
    const call = t.calls()[0];
    const at = (s: string) => call.stdin.indexOf(s);
    expect(at('<shared_documents>')).toBe(0);
    const file = path.join(t.ctx.filesDir(), doc.meta.file);
    expect(call.stdin).toContain(`<document name="report.pdf" format="pdf" pages="3" file="${file}">\n[Page 1]\n\nPlatform report`);
    // Every page, not only the anchored one.
    for (const n of [1, 2, 3]) {
      expect(call.stdin).toContain(`[Page ${n}]`);
      expect(call.stdin).toContain(`Page ${n} ends here.`);
    }
    expect(at('</document>')).toBeLessThan(at('<thread_context>'));
    expect(call.stdin).toContain('The user opened a side thread on this passage (page 2) of the document "report.pdf" they shared earlier');
    expect(call.stdin).toContain(`> ${blocks[i].text}`);
    expect(at('<thread_context>')).toBeLessThan(at('what does this rely on?'));

    // The follow-up resumes and sends only the new turn.
    await ask(first.thread_id, 'and page 3?');
    const next = t.calls()[1];
    expect(next.argv.slice(-2)).toEqual(['--resume', first.session_id]);
    expect(next.stdin).not.toContain('[Page 1]');
  });

  it('a long PDF is read once per agent in a reader session that every thread forks', async () => {
    const { t, sharePdf, thread, ask } = await setup();
    const doc = (await sharePdf(reportPdf(40))).body;
    expect(doc.content.length).toBeGreaterThan(READER_MIN_CHARS);
    const blocks = pdfBlocks(doc.content);
    const on = (page: number) => blocks.findIndex((b) => b.text.startsWith(`Page ${page} opens here.`));

    const a = await ask(await thread(doc.id, on(7)), 'what is this about?');
    const [read, forkA] = t.calls();
    expect(read.stdin.indexOf('<shared_documents>')).toBe(0);
    expect(read.stdin).toContain('Page 40 ends here.');
    expect(read.stdin).toContain('<document_ready>');
    const reader = t.ctx.store.getReaderSession(doc.id, 'r', a.cwd!)!;
    expect(forkA.argv.slice(-3)).toEqual(['--resume', reader.claude_session_id, '--fork-session']);
    expect(forkA.stdin).not.toContain('[Page 1]');
    expect(forkA.stdin).toMatch(/^<thread_context>\nThe user opened a side thread on this passage \(page 7\) of the document "report.pdf"/);

    // A second thread, over a page break: forked from the same reader, the document stays a cache read.
    const b = await ask(await thread(doc.id, on(20) - 2, on(20)), 'and here?');
    expect(t.calls()).toHaveLength(3);
    expect(t.calls()[2].argv.slice(-3)).toEqual(['--resume', reader.claude_session_id, '--fork-session']);
    expect(t.calls()[2].stdin).toContain('these 3 consecutive passages (pages 19–20) of the document "report.pdf"');
    expect(JSON.parse(b.markers!)).toEqual(['report.pdf already read, session forked']);
  });

  it('a scan tells the agent its text is incomplete and where the file is', async () => {
    const { t, ch, sharePdf, ask } = await setup();
    const doc = (await sharePdf(makePdf({ pages: [{ scanned: true }] }), 'scan.pdf')).body;
    await ask(ch.rootThreadId, 'what does the scan say?');
    const stdin = t.calls()[0].stdin;
    expect(stdin).toContain(`<document name="scan.pdf" format="pdf" pages="1" file="${path.join(t.ctx.filesDir(), doc.meta.file)}">\nThis PDF has little or no text layer (it looks scanned)`);
    expect(stdin).toContain('open the file with the Read tool');
  });
});
