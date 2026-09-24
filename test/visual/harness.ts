// Starts an isolated Agent Chat (temp config + data, fake claude) seeded with fixed messages, for Playwright.
// Usage: tsx test/visual/harness.ts   (port 4799, token "visual")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../server/app.ts';
import { appRoot } from '../../server/paths.ts';

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
const { thread } = store.upsertParagraphThread(reply, 1, '- Availability **99.98 %** against an SLO of 99.95 %');
const tm = store.insertMessage({ thread_id: thread.id, author_kind: 'user', content_md: 'Which week dipped?', status: 'done' });
store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(t + 1000, tm.id);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: VISUAL_PORT }, () => {
  console.log(`visual harness ready http://127.0.0.1:${VISUAL_PORT}/c/${conversation.id}?t=${VISUAL_TOKEN}`);
  fs.writeFileSync(path.join(os.tmpdir(), `ac-visual-${VISUAL_PORT}.json`), JSON.stringify({ conversationId: conversation.id, threadId: thread.id }));
});
const stop = () => {
  ctx.close();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
