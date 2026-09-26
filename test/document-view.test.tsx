// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChildThread, Message } from '../web/src/lib/api.ts';
import { chunkBlocks, chunkOf, docMeta, isMarkdownFile, outline, pickFile, readingTime, sectionAt, shareDocument, trailAt } from '../web/src/lib/document.ts';
import { ContentsHost, useContents } from '../web/src/components/DocContents.tsx';
import { DocumentMessage } from '../web/src/components/DocumentMessage.tsx';
import { SidebarContext } from '../web/src/lib/useSidebar.ts';
import { parseMessage } from '../web/src/markdown/parse.ts';

/** A long document: chapters (h2) with sections (h3), each a few paragraphs, a list and a code block. */
function book(chapters: number): string {
  const out = ['# Handbook', '', 'Opening words of the handbook.', ''];
  for (let c = 1; c <= chapters; c++) {
    out.push(`## ${c}. Chapter`, '', `Chapter ${c} introduction.`, '');
    for (let s = 1; s <= 3; s++) {
      out.push(`### ${c}.${s} Section`, '');
      for (let p = 1; p <= 4; p++) out.push(`Paragraph ${c}.${s}.${p} ${'says a few things about the storage engine and its trade-offs '.repeat(6).trim()}.`, '');
      out.push('- one\n- two', '', '```ts\nexport const x = 1;\n```', '');
    }
  }
  return out.join('\n').trimEnd();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('document structure', () => {
  let blocks: Awaited<ReturnType<typeof parseMessage>>;
  beforeAll(async () => {
    blocks = await parseMessage(book(40));
  });

  it('outlines h1–h3 headings in order', () => {
    const h = outline(blocks!.blocks);
    expect(h[0]).toEqual({ index: 0, level: 1, text: 'Handbook' });
    expect(h.filter((x) => x.level === 2)).toHaveLength(40);
    expect(h.filter((x) => x.level === 3)).toHaveLength(120);
    expect(h.map((x) => x.index)).toEqual([...h.map((x) => x.index)].sort((a, b) => a - b));
  });

  it('finds the section of any block and its trail', () => {
    const h = outline(blocks!.blocks);
    const s = h.find((x) => x.text === '7.2 Section')!;
    expect(sectionAt(h, s.index)).toBe(s);
    expect(sectionAt(h, s.index + 3)).toBe(s);
    expect(trailAt(h, s.index + 3)).toBe('7. Chapter › 7.2 Section');
    expect(sectionAt(h, 0)?.text).toBe('Handbook');
  });

  it('chunks every block exactly once, in bounded chunks, starting sections where it can', () => {
    const all = blocks!.blocks;
    const chunks = chunkBlocks(all);
    expect(chunks[0].from).toBe(0);
    expect(chunks.at(-1)!.to).toBe(all.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].from).toBe(chunks[i - 1].to);
    expect(Math.max(...chunks.map((c) => c.to - c.from))).toBeLessThanOrEqual(40);
    expect(Math.max(...chunks.map((c) => c.chars))).toBeLessThanOrEqual(7500 + 1000);
    const leads = chunks.map((c) => all[c.from].node[0]);
    expect(leads.filter((t) => t === 'h2' || t === 'h3').length).toBeGreaterThan(chunks.length / 2);
    for (const b of [0, 17, all.length - 1]) {
      const k = chunkOf(chunks, b);
      expect(chunks[k].from <= b && b < chunks[k].to).toBe(true);
    }
  });

  it('reads the time and the file kind', () => {
    expect(readingTime(100)).toBe('1 min read');
    expect(readingTime(49_706)).toBe('3 h 36 min read');
    expect(isMarkdownFile({ name: 'Spec.MD' })).toBe(true);
    expect(isMarkdownFile({ name: 'spec.pdf' })).toBe(false);
    // PDFs are documents too; a file of another kind is picked only to say why it was refused.
    const list = [new File(['x'], 'a.png'), new File(['# b'], 'b.md')] as unknown as FileList;
    expect(pickFile(list)?.name).toBe('b.md');
    expect(pickFile([new File(['x'], 'a.png'), new File(['x'], 'c.pdf')] as unknown as FileList)?.name).toBe('c.pdf');
    expect(pickFile([new File(['x'], 'a.pdf')] as unknown as FileList)?.name).toBe('a.pdf');
  });
});

describe('sharing a document', () => {
  it('posts the file name and text to the thread, and refuses other formats before any request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'm1', meta: { kind: 'document', name: 'notes.md', title: null, words: 2 } }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const m = await shareDocument('t1', new File(['Two words'], 'notes.md'));
    expect(docMeta(m)?.name).toBe('notes.md');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/threads/t1/documents');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'notes.md', content: 'Two words' });
    await expect(shareDocument('t1', new File(['x'], 'notes.txt'))).rejects.toThrow(/not a Markdown or PDF document/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('DocumentMessage', () => {
  const observed: Element[] = [];
  const stubObservers = () => {
    observed.length = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = (el: Element) => observed.push(el);
        disconnect = () => {};
      },
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = () => {};
        disconnect = () => {};
      },
    );
  };

  const message = (content: string): Message => ({
    id: 'doc1',
    threadId: 't1',
    authorKind: 'user',
    authorId: null,
    content,
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
    meta: { kind: 'document', name: 'handbook.md', title: 'Handbook', words: 60_000 },
  });

  it('renders a long document in full height but only a few chunks of it in the DOM', async () => {
    stubObservers();
    const src = book(60);
    const threads: ChildThread[] = [];
    const { container } = render(<DocumentMessage m={message(src)} childThreads={threads} allowThreads onOpenThread={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const parsed = (await parseMessage(src))!;
    const chunks = container.querySelectorAll('.doc-chunk');
    expect(chunks.length).toBe(chunkBlocks(parsed.blocks).length);
    expect(chunks.length).toBeGreaterThan(20);
    // Before the viewport is known: the first and last chunks, where a reader lands.
    expect(container.querySelectorAll('.doc-chunk:not(.is-placeholder)')).toHaveLength(4);
    expect(container.querySelectorAll('[data-block]').length).toBeLessThan(parsed.blocks.length / 5);
    // Placeholders hold the height of the text they stand for.
    const placeholder = container.querySelector<HTMLElement>('.doc-chunk.is-placeholder')!;
    expect(parseFloat(placeholder.style.height)).toBeGreaterThan(100);
    expect(observed.length).toBe(chunks.length);
    expect(container.querySelector('.doc-name')?.textContent).toBe('handbook.md');
    expect(container.querySelector('.doc-sub')?.textContent).toMatch(/60,000 words · 4 h 21 min read/);
  });

  it('lists the threads on the document and shows their count', async () => {
    stubObservers();
    const src = book(3);
    const t = (id: string, blockIndex: number): ChildThread =>
      ({ id, parentMessageId: 'doc1', blockIndex, blockEnd: blockIndex, replyCount: 2, lastActivity: Date.now(), channel: null }) as unknown as ChildThread;
    const { container } = render(<DocumentMessage m={message(src)} childThreads={[t('b', 9), t('a', 3)]} allowThreads onOpenThread={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('.doc-threads-btn')?.textContent).toContain('2');
    expect(container.querySelectorAll('.doc-tick')).toHaveLength(2);
  });
});

describe('contents pane', () => {
  /** The app shell's sidebar: the remembered choice, and a borrow that holds it on the rail. */
  function Shell({ chosen: initial, log }: { chosen: boolean; log: boolean[] }) {
    const [chosen, setChosen] = useState(initial);
    const [borrowed, setBorrowed] = useState(false);
    const collapsed = chosen || borrowed;
    log.push(collapsed);
    const expand = () => {
      setBorrowed(false);
      setChosen(false);
    };
    return (
      <SidebarContext.Provider value={{ collapsed, borrow: setBorrowed }}>
        <button id="expand" onClick={expand} />
        <ContentsHost>
          <Doc />
        </ContentsHost>
      </SidebarContext.Provider>
    );
  }
  function Doc() {
    const c = useContents()!;
    const open = c.openId === 'doc1';
    return (
      <>
        <button id="toggle" onClick={() => c.toggle('doc1')} data-open={open} />
        <button id="publish" onClick={() => c.publish({ id: 'doc1', name: 'h.md', headings: [{ index: 0, level: 1, text: 'Handbook' }], threads: [], jump: () => {} })} />
      </>
    );
  }
  const click = async (el: Element | null) =>
    act(async () => {
      (el as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });

  it('takes the open sidebar’s space and gives it back on close', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const log: boolean[] = [];
    const { container } = render(<Shell chosen={false} log={log} />);
    await click(container.querySelector('#toggle'));
    await click(container.querySelector('#publish'));
    expect(log.at(-1)).toBe(true);
    expect(container.querySelector('.contents-pane')).not.toBeNull();
    expect(container.querySelector('.contents-item')?.textContent).toBe('Handbook');
    await click(container.querySelector('#toggle'));
    expect(log.at(-1)).toBe(false);
    expect(container.querySelector('#toggle')?.getAttribute('data-open')).toBe('false');
  });

  it('leaves a collapsed sidebar collapsed, and closes when the sidebar is expanded', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const log: boolean[] = [];
    const { container } = render(<Shell chosen={true} log={log} />);
    await click(container.querySelector('#toggle'));
    await click(container.querySelector('#toggle'));
    expect(log.at(-1)).toBe(true);
    await click(container.querySelector('#toggle'));
    await click(container.querySelector('#expand'));
    expect(log.at(-1)).toBe(false);
    expect(container.querySelector('#toggle')?.getAttribute('data-open')).toBe('false');
  });
});
