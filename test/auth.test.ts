import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, PORT } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

describe('auth and request guard', () => {
  it('rejects a wrong Host with 403', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    expect((await call('GET', '/api/config', undefined, { host: 'evil.com' })).status).toBe(403);
    expect((await call('GET', '/api/config', undefined, { host: `127.0.0.1:${PORT + 1}` })).status).toBe(403);
    expect((await call('GET', '/api/config')).status).toBe(200);
    expect((await call('GET', '/api/config', undefined, { host: `localhost:${PORT}` })).status).toBe(200);
  });

  it('rejects a missing or wrong cookie with 403', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    expect((await call('GET', '/api/conversations', undefined, { cookie: '' })).status).toBe(403);
    expect((await call('GET', '/api/conversations', undefined, { cookie: 'agent_chat_token=nope' })).status).toBe(403);
  });

  it('rejects a cross-origin request', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    expect((await call('POST', '/api/conversations', { kind: 'chat' }, { origin: 'http://evil.com' })).status).toBe(403);
    expect((await call('POST', '/api/conversations', { kind: 'chat' }, { origin: `http://127.0.0.1:${PORT}` })).status).toBe(201);
  });

  it('login sets an HttpOnly SameSite=Strict cookie only for the right token', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    expect((await call('POST', '/api/login', { token: 'wrong' }, { cookie: '' })).status).toBe(403);
    const ok = await call('POST', '/api/login', { token: ctx.token }, { cookie: '' });
    expect(ok.status).toBe(200);
    const setCookie = ok.res.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('keeps the same token across restarts', async () => {
    const a = makeApp();
    const token = a.ctx.token;
    a.ctx.close();
    const { createApp } = await import('../server/app.ts');
    const b = createApp({ configDir: a.configDir, dataDir: a.dataDir, port: PORT, watch: false });
    cleanup.push(() => b.ctx.close());
    expect(b.ctx.token).toBe(token);
  });
});
