import fs from 'node:fs';
import path from 'node:path';
import { MarkdownDocument } from '@comark/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { blocksOf, parseComark } from '../shared/markdown.ts';
import { blockSource } from '../web/src/markdown/blocks.ts';
import { components } from '../web/src/markdown/components.tsx';
import { parseMessage, type Parsed } from '../web/src/markdown/parse.ts';
import { safeUrl, sanitizeNodes } from '../web/src/markdown/sanitize.ts';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'markdown', name), 'utf8');
const html = (p: Parsed) => renderToStaticMarkup(<MarkdownDocument value={{ nodes: p.tree }} components={components} />);

describe('parseMessage', () => {
  it('parses prose and never throws', async () => {
    const p = await parseMessage('# Hi\n\nSome **bold** text.');
    expect(p!.blocks.map((b) => b.node[0])).toEqual(['h1', 'p']);
    expect(await parseMessage('::graph-table\n---\ntitle\n  rows: [')).toBeNull();
  });

  it('an unparseable prefix gives null and a later prefix parses again', async () => {
    const src = fixture('mixed.md');
    let held = 0;
    let last: Parsed | null = null;
    for (let i = 1; i <= src.length; i++) {
      const p = await parseMessage(src.slice(0, i));
      if (p) last = p;
      else held++;
    }
    expect(held).toBeGreaterThan(0); // the partial-YAML case really happens
    expect(held).toBeLessThan(src.length / 4);
    expect(last!.blocks).toHaveLength(12);
  });
});

describe('sanitiser', () => {
  const clean = async (md: string, tags: string[] = []) => {
    const doc = await parseComark(md);
    return sanitizeNodes(doc.nodes, new Set(tags));
  };
  const render = async (md: string) => html((await parseMessage(md))!);

  it('keeps raw HTML as text', async () => {
    const out = await render('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('drops javascript: and other unsafe URLs', async () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('java\nscript:alert(1)')).toBeUndefined();
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,x')).toBeUndefined();
    expect(safeUrl('//evil.example')).toBeUndefined();
    expect(safeUrl('https://ok.example/a')).toBe('https://ok.example/a');
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeUrl('./docs/x.md')).toBe('./docs/x.md');
    expect(safeUrl('#anchor')).toBe('#anchor');
    const out = await render('[a](<javascript:alert(1)>) [b][r]\n\n[r]: javascript:alert(2)\n\n![i](javascript:x)');
    expect(out).not.toMatch(/(href|src)="\s*javascript/i);
    expect(out).not.toContain('<img');
  });

  it('opens links in a new tab with noopener', async () => {
    const out = await render('[docs](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('strips style, on* handlers, ids and positioning classes', async () => {
    const [n] = await clean('::graph-meter{value=0.5 style="color:red" onclick="x" .fixed .inset-0 .max-w-xl #id}\n::', ['graph-meter']);
    expect(n).toEqual(['graph-meter', { value: '0.5', class: 'max-w-xl' }]);
    const [p] = await clean('Text {.fixed .inset-0 .z-50}');
    expect(p).toEqual(['p', {}, 'Text']);
    const [h] = await clean('# Title {#m-01}');
    expect(h).toEqual(['h1', {}, 'Title']);
  });

  it('drops numeric keys from a half-streamed YAML scalar', async () => {
    const [, n] = await clean('Intro\n\n::graph-table\n---\ntitle', ['graph-table']);
    expect(n).toEqual(['graph-table', {}]);
  });

  it('turns unknown tags into the fallback frame with their source', async () => {
    const [n] = await clean('::evil-widget{a=1}\nhello\n::');
    expect(n).toEqual(['md-unknown', { tag: 'evil-widget', source: '::evil-widget{a="1"}\nhello\n::', inline: false }]);
    const out = await render('::evil-widget{a=1}\nhello\n::');
    expect(out).toContain('[ evil-widget ]');
    expect(out).not.toContain('<evil-widget');
    const inline = await render('Some :bad-inline{x=1} text');
    expect(inline).toContain('<code class="md-unknown-inline"');
  });

  it('keeps GFM table alignment and task list state', async () => {
    const [t] = await clean('| a | b |\n|:--|--:|\n| 1 | 2 |');
    expect(JSON.stringify(t)).toContain('"align":"right"');
    expect(JSON.stringify(t)).not.toContain('style');
    const [l] = await clean('- [x] done\n- [ ] todo');
    expect(JSON.stringify(l)).toContain('["input",{"type":"checkbox","checked":true}]');
    expect(JSON.stringify(l)).toContain('["input",{"type":"checkbox","checked":false}]');
  });
});

describe('blocks', () => {
  it('splits top-level nodes the same way as the server', async () => {
    const src = fixture('mixed.md');
    const p = (await parseMessage(src))!;
    const server = await blocksOf(src);
    expect(p.blocks.map((b) => b.index)).toEqual(server.map((_, i) => i));
    expect(p.blocks.map((b) => b.node[0])).toEqual(['h2', 'p', 'ul', 'table', 'pre', 'graph-meter', 'graph-table', 'row', 'pre', 'blockquote', 'hr', 'p']);
  });

  it('block_text round-trips through parse', async () => {
    for (const name of ['mixed.md', 'report.md', 'catalog.md']) {
      const src = fixture(name);
      const raw = (await parseComark(src)).nodes.filter(Array.isArray);
      const texts = await blocksOf(src);
      expect(texts).toHaveLength(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const again = (await parseComark(texts[i])).nodes.filter(Array.isArray);
        expect(again).toEqual([raw[i]]);
      }
    }
  });

  it('block_text is the source as written, including a figure\'s props', async () => {
    const texts = await blocksOf(fixture('mixed.md'));
    expect(texts[2]).toBe('- [x] Cache warmed\n- [ ] Flaky test quarantined\n  - nested item with *emphasis*');
    expect(texts[6]).toContain('footer: [2 routes, "298 kB", "290 kB"]');
    expect(texts[6].endsWith('\n::')).toBe(true);
  });

  it('serialises a single node back to markdown', async () => {
    const [node] = (await parseComark('::graph-meter{title="Coverage" value=0.86}\n::')).nodes;
    expect(await blockSource(node)).toBe('::graph-meter{title="Coverage" value="0.86"}\n::');
  });
});
