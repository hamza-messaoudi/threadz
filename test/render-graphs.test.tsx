import fs from 'node:fs';
import path from 'node:path';
import { MarkdownDocument } from '@comark/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAgent } from '../server/config/validate.ts';
import { buildArgs, comarkGraphsPrompt } from '../server/runner/spawn.ts';
import { components } from '../web/src/markdown/components.tsx';
import { parseMessage } from '../web/src/markdown/parse.ts';
import { graphTags } from '../web/src/markdown/tags.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const PROMPT = comarkGraphsPrompt();
const mention = (id: string, text: string) => [{ kind: 'agent', id, start: text.indexOf(`@${id}`), end: text.indexOf(`@${id}`) + id.length + 1 }];
const systemOf = (argv: string[]) => argv[argv.indexOf('--append-system-prompt') + 1];

describe('render: graphs config', () => {
  it('accepts "graphs" and rejects anything else', () => {
    expect(validateAgent({ name: 'r', render: 'graphs' }, 'body', 'r.md', 'r').render).toBe('graphs');
    expect(validateAgent({ name: 'r' }, 'body', 'r.md', 'r').render).toBeUndefined();
    expect(() => validateAgent({ name: 'r', render: 'charts' }, 'body', 'r.md', 'r')).toThrow(/render/);
  });

  it('buildArgs appends the catalog after the agent body, only when opted in', () => {
    const mode = { settingsPath: '/s.json', partial: true };
    const on = buildArgs({ model: 'sonnet', systemPrompt: 'You are r.', render: 'graphs' }, {}, mode);
    const off = buildArgs({ model: 'sonnet', systemPrompt: 'You are r.' }, {}, mode);
    expect(systemOf(on)).toBe(`You are r.\n\n${PROMPT}`);
    expect(systemOf(off)).toBe('You are r.');
  });
});

describe('render: graphs with fake claude', () => {
  it('only opted-in agents get the catalog, and their flags stay byte-identical across turns', async () => {
    const t = makeFakeApp({
      'agents/charts.md': agentFile('charts', 'You are charts.', 'render: graphs\n'),
      'agents/plain.md': agentFile('plain'),
    });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    // One agent per turn: the fake's session list is not safe for two new sessions at once.
    for (const text of ['@charts first', '@plain first', '@charts second', '@plain second']) {
      const id = text.slice(1, text.indexOf(' '));
      const r = await t.post(ch.rootThreadId, text, mention(id, text));
      await t.settled(r.agentMessageIds[0]);
    }
    const calls = t.calls();
    const charts = calls.filter((c) => systemOf(c.argv).startsWith('You are charts.'));
    const plain = calls.filter((c) => systemOf(c.argv).startsWith('You are plain.'));
    expect(charts).toHaveLength(2);
    expect(plain).toHaveLength(2);
    expect(systemOf(charts[0].argv)).toBe(`You are charts.\n\n${PROMPT}`);
    for (const c of plain) expect(systemOf(c.argv)).not.toContain('graph-');
    for (const pair of [charts, plain]) expect(JSON.stringify(pair[1].argv.slice(0, pair[0].argv.length))).toBe(JSON.stringify(pair[0].argv));
  });

  it('turning it on starts a new session marked "agent config changed"', async () => {
    const t = makeFakeApp({ 'agents/r.md': agentFile('r') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const first = await t.post(ch.rootThreadId, '@r one', mention('r', '@r one'));
    await t.settled(first.agentMessageIds[0]);
    fs.writeFileSync(path.join(t.configDir, 'agents', 'r.md'), agentFile('r', 'You are r.', 'render: graphs\n'));
    t.ctx.reloadConfig();
    const second = await t.post(ch.rootThreadId, '@r two', mention('r', '@r two'));
    const m = await t.settled(second.agentMessageIds[0]);
    expect(JSON.parse(m.markers!)).toEqual(['new session: agent config changed']);
    expect(systemOf(t.calls()[1].argv)).toContain('::graph-table');
  });
});

describe('the catalog prompt', () => {
  it('stays under 4,000 tokens', () => {
    // No tokenizer offline: ~3 characters per token is a pessimistic rate for YAML-heavy text
    // (English prose is ~4). 12,000 characters therefore bounds 4,000 tokens.
    expect(PROMPT.length / 3).toBeLessThan(4000);
  });

  it('has one example per tag, and every example renders without a fallback or empty frame', async () => {
    const parsed = (await parseMessage(PROMPT))!;
    const used = new Set<string>();
    const walk = (n: unknown) => {
      if (Array.isArray(n) && typeof n[0] === 'string') {
        used.add(n[0]);
        n.slice(2).forEach(walk);
      }
    };
    parsed.tree.forEach(walk);
    for (const tag of graphTags) expect(used, tag).toContain(tag);
    expect(used).not.toContain('md-unknown');
    const html = renderToStaticMarkup(<MarkdownDocument value={{ nodes: parsed.tree }} components={components} />);
    expect(html).not.toContain('· · ·');
    expect(html).not.toContain('md-unknown');
  });
});
