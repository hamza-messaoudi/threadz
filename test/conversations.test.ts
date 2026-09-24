import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, tmpDir } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('conversation CRUD', () => {
  it('creates channels and chats with a root thread, renames and archives', async () => {
    const root = tmpDir();
    const dir = path.join(root, 'proj');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const { ctx, call } = makeApp({ 'config.yaml': `dirRoots: [${JSON.stringify(root)}]` });
    cleanup.push(() => ctx.close());
    const ch = await call('POST', '/api/conversations', { kind: 'channel', name: 'main', dir });
    expect(ch.status).toBe(201);
    expect(ch.body.rootThreadId).toBeTruthy();
    expect(ch.body.dir).toBe(dir);
    const thread = await call('GET', `/api/threads/${ch.body.rootThreadId}`);
    expect(thread.body.messages).toEqual([]);

    expect((await call('POST', '/api/conversations', { kind: 'channel', name: 'x', dir: root })).status).toBe(400);
    expect((await call('POST', '/api/conversations', { kind: 'channel', name: '' })).status).toBe(400);

    const chat = await call('POST', '/api/conversations', { kind: 'chat' });
    expect(chat.body.kind).toBe('chat');
    expect(chat.body.dir).toBeNull();

    const renamed = await call('PATCH', `/api/conversations/${ch.body.id}`, { name: 'renamed' });
    expect(renamed.body.name).toBe('renamed');
    await call('PATCH', `/api/conversations/${chat.body.id}`, { archived: true });
    const list = await call('GET', '/api/conversations');
    expect(list.body.map((c: any) => c.name)).toEqual(['renamed']);
  });
});
