// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { MarkdownDocument } from '@comark/react';
import { cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { isElement, type Node } from '../shared/markdown.ts';
import { components } from '../web/src/markdown/components.tsx';
import { MarkdownBlocks, MessageMarkdown } from '../web/src/markdown/MessageMarkdown.tsx';
import { parseMessage } from '../web/src/markdown/parse.ts';
import { graphTags } from '../web/src/markdown/tags.ts';
import { GRAPH_ADAPTERS } from '../web/src/registry/default/graph-comark/adapters.ts';

afterEach(cleanup);

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'markdown', name), 'utf8');
const html = (nodes: Node[]) => renderToStaticMarkup(<MarkdownDocument value={{ nodes }} components={components} />);

/** First node per tag in the demo's report and catalog (their examples come from the mdxcn docs). */
async function examples(): Promise<Map<string, Node>> {
  const found = new Map<string, Node>();
  const walk = (n: Node) => {
    if (!isElement(n)) return;
    if (!found.has(n[0])) found.set(n[0], n);
    n.slice(2).forEach((c) => walk(c as Node));
  };
  for (const f of ['report.md', 'catalog.md']) (await parseMessage(fixture(f)))!.tree.forEach(walk);
  return found;
}

describe('graph components', () => {
  it('maps all 32 mdxcn graphs plus row', () => {
    expect(graphTags.filter((t) => t.startsWith('graph-'))).toHaveLength(32);
    expect(graphTags).toContain('row');
    for (const t of graphTags) expect(components[t], t).toBeTypeOf('function');
  });

  it('renders every component from its example props, in its final state', async () => {
    const ex = await examples();
    for (const tag of graphTags) {
      const node = ex.get(tag);
      expect(node, `example for ${tag}`).toBeDefined();
      const out = html([node!]);
      expect(out, tag).toMatch(/<figure|<div/);
      expect(out, `${tag} is not pending`).not.toContain('· · ·');
      expect(out, `${tag} starts hidden`).not.toMatch(/opacity:\s*0[;"]/);
    }
  });

  it('renders an empty frame, never a throw, when required props are missing', async () => {
    for (const tag of graphTags) {
      const p = (await parseMessage(`::${tag}{title="Pending"}\n::`))!;
      let out = '';
      expect(() => (out = html(p.tree)), tag).not.toThrow();
      const required = (GRAPH_ADAPTERS as Record<string, { required?: readonly string[] }>)[tag].required ?? [];
      if (required.length) {
        expect(out, tag).toContain('· · ·');
        expect(out, tag).toMatch(/\[ (<!-- -->)?Pending(<!-- -->)? \]/);
      }
    }
  });

  it('coerces scalar props (numbers, booleans) from attributes', async () => {
    const p = (await parseMessage('::graph-meter{title="Coverage" value=0.86 ticks=10}\n::'))!;
    const out = html(p.tree);
    expect(out).toContain('86%');
  });
});

describe('fault isolation', () => {
  it('a broken figure shows the fallback frame and the rest of the message renders', async () => {
    const md = 'Before the figure.\n\n::graph-table\n---\ntitle: Broken\nheaders: [A, B]\nrows: 5\n---\n::\n\nAfter the figure.';
    const errors = console.error;
    console.error = () => {}; // React logs the caught error
    try {
      const { container, findByText } = render(<MessageMarkdown id="broken" content={md} />);
      await findByText('After the figure.');
      expect(container.textContent).toContain('Before the figure.');
      const frame = container.querySelector('[data-error]');
      expect(frame).not.toBeNull();
      expect(frame!.textContent).toContain('graph-table');
      expect(frame!.textContent).toMatch(/Could not render this figure: .+/);
      await findByText(/rows: 5/);
    } finally {
      console.error = errors;
    }
  });
});

describe('clock figures', () => {
  it('share one ticker, stopped while the tab is hidden', async () => {
    const { activeTickers } = await import('../web/src/markdown/ticker.ts');
    const md = '::graph-timer{title="A" at="2026-09-01T00:00:00Z"}\n::\n\n::graph-countdown{title="B" to="2027-01-01T00:00:00Z"}\n::\n\n::graph-timer{title="C" kind="clock"}\n::';
    const { findAllByText, unmount } = render(<MessageMarkdown id="clocks" content={md} />);
    await findAllByText(/\[ (A|B|C) \]/);
    expect(activeTickers()).toBe(1);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(activeTickers()).toBe(0);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(activeTickers()).toBe(1);
    unmount();
    expect(activeTickers()).toBe(0);
  });
});

describe('streaming figures', () => {
  it('keeps a figure whose props briefly stop parsing', async () => {
    const { holdFigureProps } = await import('../web/src/markdown/MessageMarkdown.tsx');
    const full = (await parseMessage('::graph-meter\n---\ntitle: Coverage\nvalue: 0.5\n---\n::'))!;
    const glitch = (await parseMessage('::graph-meter\n---\ntitle\n---\n::'))!;
    expect(holdFigureProps(full, glitch).blocks.at(-1)!.node).toBe(full.blocks.at(-1)!.node);
    const grown = (await parseMessage('::graph-meter\n---\ntitle: Coverage\nvalue: 0.5\nticks: 20\n---\n::'))!;
    expect(holdFigureProps(full, grown)).toBe(grown);
  });
});

describe('streaming prefixes', () => {
  it('every character prefix of the fixtures renders with no error reaching React; failed parses keep the last tree', async () => {
    const errors = console.error;
    const seen: unknown[] = [];
    console.error = (...a: unknown[]) => seen.push(a);
    try {
      for (const name of ['mixed.md', 'streaming.md']) {
        const src = fixture(name);
        let last: Awaited<ReturnType<typeof parseMessage>> = null;
        const view = render(<div />);
        for (let i = 1; i <= src.length; i++) {
          const p = await parseMessage(src.slice(0, i));
          if (p) last = p;
          if (last) expect(() => view.rerender(<MarkdownBlocks parsed={last!} streaming />), `${name} @${i}`).not.toThrow();
        }
        view.rerender(<MarkdownBlocks parsed={last!} />);
        expect(view.container.querySelector('[data-error]'), name).toBeNull();
        view.unmount();
      }
      // Errors caught by a BlockBoundary are expected mid-stream; nothing else may be logged.
      expect(seen.map((a) => (a as unknown[]).map(String).join(' ')).filter((t) => !t.includes('error boundary you provided, BlockBoundary'))).toEqual([]);
    } finally {
      console.error = errors;
    }
  }, 60000);
});
