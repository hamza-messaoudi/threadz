import { afterEach, describe, expect, it } from 'vitest';
import { cleanSnippet } from '../web/src/lib/snippet.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('cleanSnippet', () => {
  it('turns figure blocks into a label and drops fences and closing markers', () => {
    const html = '::graph-table\n---\ntitle: Route bundles\nheaders: [Route, Size]\nrows:\n  - [&quot;/<mark>search</mark>&quot;, &quot;204 kB&quot;]\n---\n::';
    expect(cleanSnippet(html)).toBe('[figure: graph-table · Route bundles] · headers: Route, Size · rows: · /<mark>search</mark>, 204 kB');
  });

  it('uses an inline title and labels Mermaid fences as a diagram', () => {
    expect(cleanSnippet('Coverage is up.\n::graph-meter{title=&quot;<mark>Coverage</mark>&quot; value=0.86}\n::')).toBe('Coverage is up. · [figure: graph-meter · <mark>Coverage</mark>]');
    expect(cleanSnippet('See below\n```mermaid\nsequenceDiagram\n  A->>B: <mark>login</mark>\n```\nDone')).toBe('See below · [diagram] · Done');
  });

  it('cleans a snippet that starts inside a props block', () => {
    expect(cleanSnippet('…  - [&quot;/docs&quot;, &quot;<mark>121</mark> kB&quot;]\n---\n::\n\nNext paragraph')).toBe('…/docs, <mark>121</mark> kB · Next paragraph');
  });

  it('leaves plain prose alone, escaped', () => {
    expect(cleanSnippet('Quokkas are &lt;b&gt;<mark>lovely</mark>&lt;/b&gt;')).toBe('Quokkas are &lt;b&gt;<mark>lovely</mark>&lt;/b&gt;');
  });
});

describe('search into figure props', () => {
  it('finds a value that appears only in a figure and shows a clean snippet', async () => {
    const reply = 'Bundle report.\\n\\n::graph-table\\n---\\ntitle: Route bundles\\nheaders: [Route, Size]\\nrows:\\n  - [/dashboard, 168 kB]\\n  - [/zebrapage, 204 kB]\\n---\\n::\\n\\nAll within budget.';
    const t = makeFakeApp({ 'agents/r.md': agentFile('r', `FAKE_REPLY=${reply}`) });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel('general');
    const r = await t.post(ch.rootThreadId, '@r bundles', [{ kind: 'agent', id: 'r', start: 0, end: 2 }]);
    await t.settled(r.agentMessageIds[0]);
    const res = (await t.call('GET', '/api/search?q=zebrapage')).body;
    expect(res).toHaveLength(1);
    const clean = cleanSnippet(res[0].snippet);
    // The FTS window (14 tokens) may start after the `::graph-table` line; either way no YAML is left.
    expect(clean).toContain('/<mark>zebrapage</mark>, 204 kB');
    expect(clean).toContain('All within');
    expect(clean).not.toMatch(/---|::|[[\]{}]|&quot;|^- |· - /);
  });
});
