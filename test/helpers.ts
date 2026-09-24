import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../server/app.ts';

export const PORT = 4777;

export function tmpDir(prefix = 'ac-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

export function makeApp(files: Record<string, string> = {}, opts: Partial<AppOptions> = {}) {
  const configDir = tmpDir('ac-config-');
  const dataDir = tmpDir('ac-data-');
  writeFiles(configDir, files);
  const { app, ctx } = createApp({ configDir, dataDir, port: PORT, watch: false, ...opts });
  const cookie = `agent_chat_token=${ctx.token}`;
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, {
      method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        cookie,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, res };
  };
  return { app, ctx, configDir, dataDir, call };
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 10000, stepMs = 20): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
