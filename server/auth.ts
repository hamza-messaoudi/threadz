import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

export const COOKIE = 'agent_chat_token';

/** Loads the persisted token, creating it on first start so the login URL survives restarts. */
export function loadOrCreateToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch {
    // fall through
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function tokenEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Host + Origin checks for every request, cookie check for /api (except login).
 * `getPort` is read per request so tests and a late-bound listen port both work.
 */
export function guard(token: string, getPort: () => number): MiddlewareHandler {
  return async (c, next) => {
    const port = getPort();
    const host = c.req.header('host') ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return c.text('forbidden host', 403);
    const origin = c.req.header('origin');
    if (origin && origin !== `http://${host}`) return c.text('forbidden origin', 403);
    const p = c.req.path;
    if (p.startsWith('/api/') && p !== '/api/login' && p !== '/api/health') {
      if (!tokenEquals(getCookie(c, COOKIE), token)) return c.json({ error: 'not logged in' }, 403);
    }
    await next();
  };
}
