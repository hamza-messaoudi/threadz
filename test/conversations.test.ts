import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, tmpDir } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('conversation CRUD', () => {
  it('creates channels and chats with a root thread, renames and archives', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    const dir = tmpDir();
    const ch = await call('POST', '/api/conversations', { kind: 'channel', name: 'main', dir });
    expect(ch.status).toBe(201);
    expect(ch.body.rootThreadId).toBeTruthy();
    expect(ch.body.dir).toBe(dir);
    const thread = await call('GET', `/api/threads/${ch.body.rootThreadId}`);
    expect(thread.body.messages).toEqual([]);

    expect((await call('POST', '/api/conversations', { kind: 'channel', name: 'x', dir: '/does/not/exist' })).status).toBe(400);
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
