import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { COOKIE, guard, loadOrCreateToken, tokenEquals } from './auth.ts';
import { loadConfig } from './config/load.ts';
import type { LoadedConfig } from './config/types.ts';
import { watchConfig } from './config/watch.ts';
import { defaultAgent, HttpError, postUserMessage } from './core/dispatch.ts';
import { serializeConversation, serializeMessage } from './core/serialize.ts';
import { openDb } from './db/migrate.ts';
import { Store } from './db/queries.ts';
import { Hub } from './hub.ts';
import { appRoot, resolvePaths, type Paths } from './paths.ts';
import { TurnRunner } from './runner/turn.ts';
import type { MessageRow, ThreadRow } from './db/queries.ts';

export interface DirService {
  isKnown(path: string): boolean;
}

export interface WorkflowService {
  start(opts: { workflow: string; thread: ThreadRow; trigger: MessageRow; cwd: string; mentions: unknown }): { id: string };
}

export interface AppOptions {
  configDir?: string;
  dataDir?: string;
  /** Overrides config.port for the Host check (tests). */
  port?: number;
  watch?: boolean;
}

export class AppContext {
  cfg: LoadedConfig;
  readonly store: Store;
  readonly hub = new Hub();
  readonly token: string;
  runner!: TurnRunner;
  dirs: DirService = { isKnown: () => false };
  workflows: WorkflowService = {
    start: () => {
      throw new HttpError(400, 'workflows are not available yet');
    },
  };
  private stops: (() => void)[] = [];
  private configListeners: ((cfg: LoadedConfig) => void)[] = [];

  constructor(
    readonly paths: Paths,
    readonly opts: AppOptions,
  ) {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    this.cfg = loadConfig(paths.configDir);
    this.store = new Store(openDb(paths.dbFile));
    this.token = loadOrCreateToken(paths.tokenFile);
  }

  get port(): number {
    return this.opts.port ?? this.cfg.config.port;
  }

  onConfig(fn: (cfg: LoadedConfig) => void): void {
    this.configListeners.push(fn);
  }

  reloadConfig(): void {
    this.cfg = loadConfig(this.paths.configDir);
    for (const fn of this.configListeners) fn(this.cfg);
    this.hub.global('config.changed', {});
  }

  startWatching(): void {
    this.stops.push(watchConfig(this.paths.configDir, () => this.reloadConfig()));
  }

  addStop(fn: () => void): void {
    this.stops.push(fn);
  }

  private starters: (() => void)[] = [];

  /** Registers background work (scheduler, directory scan) that begins once the server listens. */
  onStart(fn: () => void): void {
    this.starters.push(fn);
  }

  start(): void {
    for (const fn of this.starters) fn();
  }

  shutdown(): void {
    this.runner?.cancelAll();
    this.close();
  }

  close(): void {
    for (const s of this.stops.splice(0)) s();
    this.store.db.close();
  }

  scratchDir(): string {
    const d = this.cfg.config.scratchDir;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

export function configPayload(cfg: LoadedConfig) {
  return {
    agents: Object.values(cfg.agents).map((a) => ({ name: a.name, description: a.description, model: a.model, tools: a.tools })),
    workflows: Object.values(cfg.workflows).map((w) => ({
      name: w.name,
      description: w.description,
      steps: w.steps.map((s) => s.agent),
    })),
    routines: Object.values(cfg.routines).map((r) => ({
      name: r.name,
      schedule: r.schedule,
      channel: r.channel,
      target: `${r.target.kind}:${r.target.id}`,
      dir: r.dir,
      yolo: r.yolo,
    })),
    problems: cfg.problems,
    claudeBin: cfg.config.claudeBin,
    scratchDir: cfg.config.scratchDir,
    defaultModel: cfg.config.defaultModel,
  };
}

export function createApp(opts: AppOptions = {}) {
  const paths = resolvePaths(opts);
  const ctx = new AppContext(paths, opts);
  const { store, hub } = ctx;
  if (opts.watch !== false) ctx.startWatching();
  ctx.runner = new TurnRunner(ctx);

  const app = new Hono();
  app.use('*', guard(ctx.token, () => ctx.port));

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : ((err as any).status ?? 500);
    if (status >= 500) console.error(err);
    return c.json({ error: err.message }, status);
  });

  // ---- auth ----
  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!tokenEquals(body.token, ctx.token)) return c.json({ error: 'bad token' }, 403);
    setCookie(c, COOKIE, ctx.token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return c.json({ ok: true });
  });
  app.get('/api/session', (c) => c.json({ ok: true }));

  // ---- config ----
  app.get('/api/config', (c) => c.json(configPayload(ctx.cfg)));

  // ---- conversations ----
  app.get('/api/conversations', (c) => c.json(store.listConversations().map(serializeConversation)));

  app.post('/api/conversations', async (c) => {
    const body = await c.req.json();
    const kind = body.kind === 'chat' ? 'chat' : 'channel';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (kind === 'channel' && !name) return c.json({ error: 'name required' }, 400);
    const dir = kind === 'channel' ? validateDirInput(ctx, body.dir) : null;
    const { conversation, rootThreadId } = store.createConversation({ kind, name: name || 'New chat', dir });
    const out = serializeConversation({ ...conversation, root_thread_id: rootThreadId, last_activity: conversation.created_at });
    hub.global('conversation.updated', out);
    return c.json(out, 201);
  });

  app.get('/api/conversations/:id', (c) => {
    const conv = store.getConversation(c.req.param('id'));
    if (!conv) return c.json({ error: 'not found' }, 404);
    return c.json(serializeConversation({ ...conv, root_thread_id: store.rootThread(conv.id).id }));
  });

  app.patch('/api/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const conv = store.getConversation(id);
    if (!conv) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json();
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (body.dir !== undefined) patch.dir = validateDirInput(ctx, body.dir);
    if (typeof body.yolo === 'boolean') patch.yolo = body.yolo ? 1 : 0;
    if (typeof body.archived === 'boolean') patch.archived = body.archived ? 1 : 0;
    store.updateConversation(id, patch);
    const out = serializeConversation({ ...store.getConversation(id)!, root_thread_id: store.rootThread(id).id });
    hub.global('conversation.updated', out);
    return c.json(out);
  });

  // ---- threads ----
  app.get('/api/threads/:id', (c) => {
    const thread = store.getThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'not found' }, 404);
    return c.json({
      thread: {
        id: thread.id,
        conversationId: thread.conversation_id,
        parentThreadId: thread.parent_thread_id,
        parentMessageId: thread.parent_message_id,
        blockIndex: thread.block_index,
        blockText: thread.block_text,
      },
      messages: store.listMessages(thread.id).map(serializeMessage),
      defaultAgent: defaultAgent(ctx, thread),
      sourceMessage: thread.parent_message_id ? serializeMessage(store.getMessage(thread.parent_message_id)!) : null,
      childThreads: store.childThreadSummaries(thread.id).map((t) => ({
        id: t.id,
        parentMessageId: t.parent_message_id,
        blockIndex: t.block_index,
        replyCount: t.reply_count,
        lastActivity: t.last_activity ?? t.created_at,
      })),
    });
  });

  app.post('/api/threads/:id/messages', async (c) => {
    const body = await c.req.json();
    return c.json(postUserMessage(ctx, c.req.param('id'), body), 201);
  });

  app.post('/api/messages/:id/cancel', (c) => {
    const msg = store.getMessage(c.req.param('id'));
    if (!msg) return c.json({ error: 'not found' }, 404);
    return c.json({ cancelled: ctx.runner.cancel(msg.id) });
  });

  app.get('/api/threads/:id/events', (c) => sse(c, `thread:${c.req.param('id')}`));
  app.get('/api/events', (c) => sse(c, 'global'));

  function sse(c: any, topic: string) {
    return streamSSE(c, async (stream) => {
      const queue: { event: string; data: string }[] = [];
      let wake: (() => void) | undefined;
      const unsub = hub.subscribe(topic, (event, data) => {
        queue.push({ event, data: JSON.stringify(data) });
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        if (!queue.length) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 25000); // keep-alive
          });
          wake = undefined;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' });
          continue;
        }
        const item = queue.shift()!;
        await stream.writeSSE(item);
      }
      unsub();
    });
  }

  // ---- static web app (production build) ----
  const webDist = path.join(appRoot, 'web', 'dist');
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    const rel = path.normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    let file = path.join(webDist, rel);
    if (!file.startsWith(webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDist, 'index.html');
    if (!fs.existsSync(file)) return c.text('web app not built; run `npm run build` or use `npm run dev`', 404);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(fs.readFileSync(file), 200, { 'content-type': type, 'cache-control': cache });
  });

  return { app, ctx };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Phase 1: a plain validated path. Phase 6 replaces this with the directory index. */
export function validateDirInput(ctx: AppContext, dir: unknown): string | null {
  if (dir === null || dir === undefined || dir === '') return null;
  if (typeof dir !== 'string') throw Object.assign(new Error('dir must be a string'), { status: 400 });
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw Object.assign(new Error(`not a directory: ${dir}`), { status: 400 });
  return abs;
}
