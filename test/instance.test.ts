import http from 'node:http';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { probePort } from '../server/instance.ts';
import { makeApp } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const listen = (server: http.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port)));

describe('single instance', () => {
  it('health answers without a login cookie but keeps the Host check', async () => {
    const { ctx, call } = makeApp();
    cleanup.push(() => ctx.close());
    const res = await call('GET', '/api/health', undefined, { cookie: '' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ app: 'agent-chat', pid: process.pid, dataDir: ctx.paths.dataDir });
    expect((await call('GET', '/api/health', undefined, { host: 'evil.com' })).status).toBe(403);
  });

  it('probePort tells a free port, another program and an Agent Chat instance apart', async () => {
    const other = http.createServer((_req, res) => res.end('hello'));
    const otherPort = await listen(other);
    cleanup.push(() => other.close());
    expect(await probePort(otherPort)).toBe('other');

    const free = http.createServer();
    const freePort = await listen(free);
    await new Promise((r) => free.close(r));
    expect(await probePort(freePort)).toBeNull();

    // A real instance: the Host check needs the actual port, so bind first, then build the app on it.
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    const { app, ctx } = makeApp({}, { port });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
    cleanup.push(() => {
      server.close();
      ctx.close();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await probePort(port)).toMatchObject({ app: 'agent-chat', pid: process.pid });
  });
});
