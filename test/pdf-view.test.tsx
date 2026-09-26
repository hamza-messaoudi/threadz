// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildThread, Message } from '../web/src/lib/api.ts';
import { pickFile, shareDocument } from '../web/src/lib/document.ts';
import { isPdfDoc, pdfBlocksOf } from '../web/src/lib/pdf.ts';
import { groupParagraphs, PdfDocumentMessage } from '../web/src/components/PdfDocument.tsx';
import { pdfText, type PdfLayout } from '../shared/pdf.ts';

// pdf.js itself does not run under jsdom: the document never finishes loading, so pages stay paper.
vi.mock('../web/src/lib/pdf.ts', async (orig) => ({
  ...(await orig<typeof import('../web/src/lib/pdf.ts')>()),
  acquirePdf: () => ({ doc: new Promise(() => {}), release: () => {} }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LAYOUT: PdfLayout = {
  v: 1,
  contents: 'outline',
  headings: [
    { index: 0, level: 1, text: 'Report', page: 1 },
    { index: 3, level: 2, text: 'Storage', page: 2 },
  ],
  pages: [
    { w: 612, h: 792, r: 0, first: 0, paras: [[0, 1, 72, 60, 300, 90], [1, 5, 72, 100, 540, 180], [6, 9, 72, 190, 540, 260]] },
    { w: 612, h: 792, r: 0, first: 3, paras: [[0, 1, 72, 60, 300, 90], [2, 4, 72, 100, 540, 180]] },
    { w: 792, h: 612, r: 0, first: 5, paras: [] },
  ],
};
const TEXT = pdfText([['Report', 'First passage of the report.', 'Second passage.'], ['Storage', 'Where the log is written first.'], []]);

const message = (): Message => ({
  id: 'pdf1',
  threadId: 't1',
  authorKind: 'user',
  authorId: null,
  content: TEXT,
  toolEvents: [],
  status: 'done',
  error: null,
  usage: null,
  runId: null,
  doneSeq: 1,
  createdAt: Date.UTC(2026, 8, 25, 9),
  cwd: null,
  sessionId: null,
  markers: [],
  mentions: null,
  meta: { kind: 'document', format: 'pdf', name: 'report.pdf', title: 'Report', words: 12, pages: 3, file: `${'a'.repeat(64)}.pdf`, layout: `${'a'.repeat(64)}.l1.json`, bytes: 1000 },
});

function stubBrowser() {
  const observed: Element[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    observe = (el: Element) => observed.push(el);
    disconnect = () => {};
  });
  vi.stubGlobal('ResizeObserver', class {
    observe = () => {};
    disconnect = () => {};
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => (url.endsWith('.json') ? LAYOUT : {}) }));
  vi.stubGlobal('fetch', fetch);
  return { observed, fetch };
}

describe('PDF documents in the browser', () => {
  it('shares a PDF as its bytes, and prefers documents in a drop', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'm1' }) }));
    vi.stubGlobal('fetch', fetch);
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'Q3 report.pdf', { type: 'application/pdf' });
    await shareDocument('t1', file);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/threads/t1/documents?name=Q3%20report.pdf');
    expect(init.headers).toEqual({ 'content-type': 'application/pdf' });
    expect(init.body).toBe(file);
    const list = [new File(['x'], 'a.png'), file] as unknown as FileList;
    expect(pickFile(list)).toBe(file);
  });

  it('reads the text into blocks with pages, once per message', () => {
    const a = pdfBlocksOf('m', TEXT);
    expect(a.map((b) => b.page)).toEqual([1, 1, 1, 2, 2]);
    expect(pdfBlocksOf('m', TEXT)).toBe(a);
    expect(isPdfDoc(message().meta)).toBe(true);
    expect(isPdfDoc({ kind: 'document', name: 'a.md', title: null, words: 1 })).toBe(false);
  });

  it('lays out every page at its size, with the header, thread badges and marks of the passages', async () => {
    const { observed } = stubBrowser();
    const t = (id: string, start: number, end: number, replies: number): ChildThread => ({ id, parentMessageId: 'pdf1', blockIndex: start, blockEnd: end, replyCount: replies, lastActivity: Date.now(), channel: null });
    const { container } = render(
      <PdfDocumentMessage m={message()} childThreads={[t('a', 1, 1, 2), t('b', 2, 3, 5)]} allowThreads onOpenThread={() => {}} activeRange={{ start: 1, end: 1 }} pendingRange={{ start: 4, end: 4 }} />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const pages = container.querySelectorAll<HTMLElement>('.pdf-page');
    expect(pages).toHaveLength(3);
    expect(observed).toHaveLength(3);
    // Page boxes have the pages' own proportions; the landscape one is wider than tall.
    const size = (p: HTMLElement) => [parseFloat(p.style.width), parseFloat(p.style.height)];
    expect(size(pages[0])[1] / size(pages[0])[0]).toBeCloseTo(792 / 612, 1);
    expect(size(pages[2])[0]).toBeGreaterThan(size(pages[2])[1]);
    expect(container.querySelector('.doc-name')?.textContent).toBe('report.pdf');
    expect(container.querySelector('.doc-sub')?.textContent).toMatch(/3 pages · 12 words · 1 min read · 2 threads/);
    // A badge where each thread's passage ends; the one over a page break ends on page 2.
    expect(pages[0].querySelector('.pdf-badge')?.textContent).toBe('2');
    expect(pages[1].querySelector('.pdf-badge')?.textContent).toBe('5');
    expect(pages[0].querySelectorAll('.pdf-rail')).toHaveLength(2);
    expect(pages[0].querySelector('.pdf-mark.is-active')).not.toBeNull();
    expect(pages[1].querySelector('.pdf-mark.is-pending')).not.toBeNull();
    expect(pages[1].querySelector('.pdf-rail.is-pending')).not.toBeNull();
  });

  it('groups a page’s text spans by paragraph, under the block index threads use', () => {
    const el = document.createElement('div');
    const divs = Array.from({ length: 10 }, (_, k) => {
      const s = document.createElement('span');
      s.textContent = `item${k}`;
      if (k !== 5) el.append(s);
      if (k === 4) el.append(document.createElement('br'));
      return s;
    });
    groupParagraphs(el, divs, LAYOUT.pages[0]);
    const groups = [...el.querySelectorAll<HTMLElement>('[data-block]')];
    expect(groups.map((g) => g.dataset.block)).toEqual(['0', '1', '2']);
    expect(groups[1].textContent).toBe('item1item2item3item4');
    expect(groups[1].querySelector('br')).not.toBeNull();
    expect(groups[2].textContent).toBe('item6item7item8');
    // Item 9 belongs to no paragraph and stays where it was, after them.
    expect(el.lastChild?.textContent).toBe('item9');
  });
});
