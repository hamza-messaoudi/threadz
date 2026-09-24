import { afterEach, describe, expect, it } from 'vitest';
import { ftsMatch, parseSearch } from '../server/core/search.ts';
import { agentFile, makeFakeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('search query parsing', () => {
  it('extracts filters and quotes terms', () => {
    expect(parseSearch('in:#general from:@researcher btree "exact phrase"')).toEqual({ terms: ['btree', 'exact phrase'], channel: 'general', agent: 'researcher' });
    expect(parseSearch('from:me hello').fromMe).toBe(true);
    expect(ftsMatch(['a"b', 'NEAR(x'])).toBe('"a""b" "NEAR(x"*');
  });
});

describe('search API', () => {
  it('finds thread replies, respects filters and never errors on FTS syntax', async () => {
    const t = makeFakeApp({ 'agents/r.md': agentFile('r', 'FAKE_REPLY=Paragraph one.\\n\\nParagraph two about zebras.'), 'agents/w.md': agentFile('w', 'FAKE_REPLY=Quokkas are lovely <b>animals</b>.') });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel('general');
    const r = await t.post(ch.rootThreadId, '@r tell me', [{ kind: 'agent', id: 'r', start: 0, end: 2 }]);
    const m = await t.settled(r.agentMessageIds[0]);
    const th = (await t.call('POST', '/api/threads', { message_id: m.id, block_index: 1 })).body;
    const r2 = await t.post(th.id, '@w what about quokkas', [{ kind: 'agent', id: 'w', start: 0, end: 2 }]);
    await t.settled(r2.agentMessageIds[0]);

    const res = (await t.call('GET', '/api/search?q=quokka')).body;
    expect(res.length).toBe(2);
    const reply = res.find((x: any) => x.authorId === 'w');
    expect(reply.inThread).toBe(true);
    expect(reply.threadId).toBe(th.id);
    expect(reply.conversationName).toBe('general');
    expect(reply.snippet).toContain('<mark>Quokkas</mark>');
    expect(reply.snippet).toContain('&lt;b&gt;'); // content is escaped

    expect((await t.call('GET', '/api/search?q=quokka from:@w')).body.length).toBe(1);
    expect((await t.call('GET', '/api/search?q=quokka from:me')).body.length).toBe(1);
    expect((await t.call('GET', '/api/search?q=quokka in:#other')).body.length).toBe(0);
    expect((await t.call('GET', '/api/search?q=zebras')).body[0].inThread).toBe(false);
    for (const bad of ['"', 'AND', 'OR NOT', 'a*b(', 'NEAR(', ':', '^x', '-']) {
      expect((await t.call('GET', `/api/search?q=${encodeURIComponent(bad)}`)).status).toBe(200);
    }
  });
});
