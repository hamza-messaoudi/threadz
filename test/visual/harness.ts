// Starts an isolated Agent Chat (temp config + data, fake claude) seeded with fixed messages, for Playwright.
// Usage: tsx test/visual/harness.ts   (port 4799, token "visual")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../server/app.ts';
import { appRoot } from '../../server/paths.ts';
import { postPdf } from '../../server/core/dispatch.ts';
import { pdfBlocks } from '../../shared/pdf.ts';
import { reportPdf } from '../pdf-fixture.ts';

export const VISUAL_PORT = Number(process.env.VISUAL_PORT ?? 4799);
export const VISUAL_TOKEN = 'a'.repeat(48);
const T0 = Date.UTC(2026, 8, 24, 9, 30);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-visual-'));
const configDir = path.join(root, 'config');
const dataDir = path.join(root, 'data');
fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.yaml'),
  `port: ${VISUAL_PORT}\nclaudeBin: ${path.join(appRoot, 'test', 'fake-claude.mjs')}\nscratchDir: ${path.join(root, 'scratch')}\n`,
);
fs.writeFileSync(path.join(configDir, 'agents', 'researcher.md'), '---\nname: researcher\ndescription: Digs into topics\n---\nYou research.\n');
fs.writeFileSync(path.join(dataDir, 'token'), VISUAL_TOKEN);

const fixture = (name: string) => fs.readFileSync(path.join(appRoot, 'test', 'fixtures', 'markdown', name), 'utf8');

const { app, ctx } = createApp({ configDir, dataDir, port: VISUAL_PORT, watch: false });
const { store } = ctx;
const { conversation, rootThreadId } = store.createConversation({ kind: 'channel', name: 'visual' });
let t = T0;
const add = (author: 'user' | 'agent', content: string) => {
  const m = store.insertMessage({ thread_id: rootThreadId, author_kind: author, author_id: author === 'agent' ? 'researcher' : null, content_md: content, status: 'done' });
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run((t += 60_000), m.id);
  return m;
};
add('user', 'Summarise the **Q3 platform** numbers, with a table and a code sample.');
const reply = add(
  'agent',
  [
    'Here is the short version. Requests grew by two thirds while `p95` stayed flat.',
    '- Availability **99.98 %** against an SLO of 99.95 %\n- 312 deploys, [runbook](https://example.com/runbook)\n- One rollback on 12 August',
    '| Route | First load | Budget |\n| :-- | --: | --: |\n| `/` | 94 kB | 110 kB |\n| `/search` | 204 kB | 180 kB |',
    '```ts\nexport function headroom(size: number, budget: number) {\n  return budget - size;\n}\n```',
    '> The search rollout is the only budget we broke.',
  ].join('\n\n'),
);
for (const extra of (process.env.VISUAL_FIXTURES ?? '').split(',').filter(Boolean)) add('agent', fixture(extra));

// VISUAL_BULK=200,500: one channel per size, with a figure in every fifth message (performance checks).
const bulkIds: Record<string, string> = {};
for (const bulk of (process.env.VISUAL_BULK ?? '').split(',').filter(Boolean).map(Number)) {
  const b = store.createConversation({ kind: 'channel', name: `bulk-${bulk}` });
  bulkIds[bulk] = b.conversation.id;
  const figures = ['::graph-meter{title="Coverage" value=0.86}\n::', '::graph-table\n---\ntitle: Routes\nheaders: [Route, Size]\nrows:\n  - ["/", "94 kB"]\n  - ["/search", "204 kB"]\n---\n::', '::graph-spark\n---\ntitle: Latency\ndata: [2, 3, 4, 3, 6, 5, 8]\n---\n::', '::graph-timeline\n---\ntitle: Rollout\nevents:\n  - { date: Aug 2, label: Staff }\n  - { date: Sep 14, label: Everyone, state: now }\n---\n::'];
  const prose = 'The nightly build stayed green for **12 days**; see [the dashboard](https://example.com) and `ci.yml`.\n\n- lint 1m 02s\n- test 7m 40s\n\n```ts\nexport const retries = 3;\n```';
  for (let i = 0; i < bulk; i++) {
    const agent = i % 2 === 1;
    const content = !agent ? `Question ${i}: how did build ${i} go?` : i % 10 === 1 || i % 10 === 5 ? `Build ${i} summary.\n\n${figures[i % figures.length]}\n\n${prose}` : `Build ${i}.\n\n${prose}`;
    const m = store.insertMessage({ thread_id: b.rootThreadId, author_kind: agent ? 'agent' : 'user', author_id: agent ? 'researcher' : null, content_md: content, status: 'done' });
    store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + i * 1000, m.id);
  }
}
const { thread } = store.upsertParagraphThread(reply, 1, '- Availability **99.98 %** against an SLO of 99.95 %');
const tm = store.insertMessage({ thread_id: thread.id, author_kind: 'user', content_md: 'Which week dipped?', status: 'done' });
store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(t + 1000, tm.id);

// A channel with a 120-page PDF between two messages, a thread on one of its paragraphs (VISUAL_PDF=0 skips it).
let pdfIds: { conversationId: string; messageId: string; threadId: string } | null = null;
if (process.env.VISUAL_PDF !== '0') {
  const p = store.createConversation({ kind: 'channel', name: 'pdf' });
  const before = store.insertMessage({ thread_id: p.rootThreadId, author_kind: 'user', content_md: 'Here is the platform report for the review.', status: 'done' });
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0, before.id);
  const doc = await postPdf(ctx, p.rootThreadId, 'platform-report.pdf', new Uint8Array(reportPdf(120)));
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 60_000, doc.id);
  const after = store.insertMessage({ thread_id: p.rootThreadId, author_kind: 'agent', author_id: 'researcher', content_md: 'I read the report. Chapter 2 is where the storage numbers are.', status: 'done' });
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 120_000, after.id);
  const msg = store.getMessage(doc.id)!;
  const blocks = pdfBlocks(msg.content_md);
  const at = blocks.findIndex((b) => b.text.startsWith('Page 2 opens here.'));
  const th = store.upsertParagraphThread(msg, at, blocks[at].text).thread;
  const q = store.insertMessage({ thread_id: th.id, author_kind: 'user', content_md: 'Why does the log come first?', status: 'done' });
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(T0 + 180_000, q.id);
  pdfIds = { conversationId: p.conversation.id, messageId: doc.id, threadId: th.id };
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: VISUAL_PORT }, () => {
  console.log(`visual harness ready http://127.0.0.1:${VISUAL_PORT}/c/${conversation.id}?t=${VISUAL_TOKEN}`);
  fs.writeFileSync(path.join(os.tmpdir(), `ac-visual-${VISUAL_PORT}.json`), JSON.stringify({ conversationId: conversation.id, threadId: thread.id, bulkIds, pdf: pdfIds }));
});
const stop = () => {
  ctx.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
