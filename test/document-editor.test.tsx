// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../web/src/lib/api.ts';
import { outline, sectionOf, sourceOf, withoutEdits } from '../web/src/lib/document.ts';
import { DocumentMessage } from '../web/src/components/DocumentMessage.tsx';
import { parseMessage } from '../web/src/markdown/parse.ts';

const DOC = ['# Plan', '', 'Opening words.', '', '## Goals', '', 'Fast search.', '', 'No regressions.', '', '## Risks', '', 'The rebuild.'].join('\n');

const message = (content = DOC, meta: object = {}): Message => ({
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
  meta: { kind: 'document', name: 'plan.md', title: 'Plan', words: 9, ...meta },
});

let calls: { url: string; method: string; body: any }[] = [];
let respond: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: { message: message(), version: 2, rebased: false, unchanged: false } });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = respond(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
const textarea = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>('.doc-editor-text')!;
const saveKey = (el: Element) => fireEvent.keyDown(el, { key: 'Enter', metaKey: true });

describe('the document editor', () => {
  it('a heading’s pencil opens its section in place; ⌘↵ saves just that section at its offset', async () => {
    const { container } = render(<DocumentMessage m={message()} allowThreads onOpenThread={() => {}} />);
    await settle();
    const pencils = container.querySelectorAll<HTMLButtonElement>('.block-edit');
    expect([...pencils].map((b) => b.getAttribute('aria-label'))).toEqual(['Edit the section Plan', 'Edit the section Goals', 'Edit the section Risks']);
    fireEvent.click(pencils[1]);
    await settle();
    const area = textarea(container);
    expect(area.value).toBe('## Goals\n\nFast search.\n\nNo regressions.');
    // The section's blocks give way to the editor; the rest of the document stays.
    expect(container.querySelector('[data-block="3"]')).toBeNull();
    expect(container.querySelector('[data-block="5"]')).not.toBeNull();
    expect(container.textContent).toContain('The rebuild.');
    fireEvent.change(area, { target: { value: '## Goals\n\nFast search, at the edge.\n\nNo regressions.' } });
    await act(async () => {
      saveKey(area);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls).toEqual([
      {
        url: '/api/documents/doc1',
        method: 'PATCH',
        body: { base: 1, ops: [{ find: '## Goals\n\nFast search.\n\nNo regressions.', replace: '## Goals\n\nFast search, at the edge.\n\nNo regressions.', at: DOC.indexOf('## Goals') }] },
      },
    ]);
    expect(container.querySelector('.doc-editor')).toBeNull();
  });

  it('cancel: Esc closes an untouched editor; with changes it asks for a second Esc, and nothing is saved', async () => {
    const { container } = render(<DocumentMessage m={message()} allowThreads onOpenThread={() => {}} />);
    await settle();
    fireEvent.click(container.querySelector('.doc-head button[aria-label="Edit the document"]')!);
    await settle();
    expect(textarea(container).value).toBe(DOC);
    fireEvent.keyDown(textarea(container), { key: 'Escape' });
    expect(container.querySelector('.doc-editor')).toBeNull();

    fireEvent.click(container.querySelector('.doc-head button[aria-label="Edit the document"]')!);
    await settle();
    fireEvent.change(textarea(container), { target: { value: DOC + '\n\nMore.' } });
    fireEvent.keyDown(textarea(container), { key: 'Escape' });
    expect(container.querySelector('.doc-editor')).not.toBeNull();
    fireEvent.keyDown(textarea(container), { key: 'Escape' });
    expect(container.querySelector('.doc-editor')).toBeNull();
    fireEvent.click(container.querySelector('.doc-head button[aria-label="Edit the document"]')!);
    await settle();
    expect(textarea(container).value).toBe(DOC);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a save that meets a newer version keeps the draft, says who saved it, and can replace it', async () => {
    respond = () => ({ status: 409, body: { error: 'plan.md changed since version 1', current: { version: 2, editedBy: { kind: 'agent', id: 'r' } } } });
    const { container } = render(<DocumentMessage m={message()} allowThreads onOpenThread={() => {}} />);
    await settle();
    fireEvent.click(container.querySelector('.doc-head button[aria-label="Edit the document"]')!);
    await settle();
    fireEvent.change(textarea(container), { target: { value: 'Mine.' } });
    await act(async () => {
      saveKey(textarea(container));
      await new Promise((r) => setTimeout(r, 30));
    });
    const alert = container.querySelector('.doc-conflict')!;
    expect(alert.textContent).toContain('@r saved version 2 while you were editing.');
    expect(textarea(container).value).toBe('Mine.');
    respond = () => ({ status: 200, body: { message: message('Mine.'), version: 3, rebased: false, unchanged: false } });
    await act(async () => {
      fireEvent.click([...alert.querySelectorAll('button')].find((b) => b.textContent === 'Save mine over theirs')!);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { base: 2, content: 'Mine.' } });
    expect(container.querySelector('.doc-editor')).toBeNull();
  });

  it('an edited document says who edited it and offers its versions', async () => {
    const { container } = render(<DocumentMessage m={message(DOC, { version: 3, editedBy: { kind: 'agent', id: 'r' }, editedAt: Date.now() })} allowThreads onOpenThread={() => {}} />);
    await settle();
    expect(container.querySelector('.doc-sub')?.textContent).toMatch(/^version 3 · edited by @r just now/);
    expect(container.querySelector('.doc-history-btn')?.textContent).toContain('v3');
  });
});

describe('document helpers', () => {
  it('a section runs from its heading to the next heading of its level or above', async () => {
    const parsed = (await parseMessage(DOC))!;
    const h = outline(parsed.blocks);
    expect(sectionOf(h, parsed.blocks.length, 3)).toEqual([2, 4]);
    expect(sectionOf(h, parsed.blocks.length, 0)).toEqual([0, 1]);
    expect(sourceOf(DOC, parsed.lines!, 5, 6)).toEqual({ text: '## Risks\n\nThe rebuild.', at: DOC.indexOf('## Risks') });
  });

  it('a streaming reply hides its edit blocks, and names the one being written', () => {
    expect(withoutEdits('Done.\n\n<document_edit name="a.md"><replace>x</replace><with>y</with></document_edit>\n\nBye.')).toEqual({ text: 'Done.\n\nBye.', drafting: null });
    expect(withoutEdits('On it.\n\n<document_edit name="a.md">\n<replace>\nhal')).toEqual({ text: 'On it.', drafting: 'a.md' });
  });
});

describe('edits in the timeline', () => {
  const base = { threadId: 't1', toolEvents: [], error: null, usage: null, runId: null, doneSeq: 2, createdAt: Date.now(), cwd: null, sessionId: null, markers: [], mentions: null };

  it('an agent’s reply shows its edit results; the note says who edited what, from where', async () => {
    const { MessageView } = await import('../web/src/components/Message.tsx');
    const reply = {
      ...base,
      id: 'a1',
      authorKind: 'agent',
      authorId: 'r',
      content: 'Tightened it.',
      status: 'done',
      meta: {
        documentEdits: [
          { name: 'plan.md', documentId: 'doc1', status: 'applied', version: 2, previous: 1, rebased: true },
          { name: 'other.md', documentId: null, status: 'failed', error: 'There is no document named other.md here.' },
        ],
      },
    } as Message;
    const { container } = render(<MessageView m={reply} />);
    const results = [...container.querySelectorAll('.edit-result')].map((e) => e.textContent);
    expect(results).toEqual(['Edited plan.md · version 2 · on top of an edit made meanwhileShow', 'Could not edit other.md: There is no document named other.md here.']);
    cleanup();
    const note = {
      ...base,
      id: 's1',
      authorKind: 'system',
      authorId: null,
      content: '@r edited plan.md (version 2)',
      status: 'done',
      meta: { kind: 'document_edit', documentId: 'doc1', name: 'plan.md', version: 2, previous: 1, by: { kind: 'agent', id: 'r' }, threadId: 'th1', restored: null, threads: { changed: 1, removed: 1 } },
    } as Message;
    const view = render(<MessageView m={note} />);
    expect(view.container.textContent).toBe('@r edited plan.md · version 2 · from a thread · 1 thread’s passage changed, 1 thread detached · Show');
  });
});
