import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { COOKIE, guard, loadOrCreateToken, tokenEquals } from './auth.ts';
import { loadConfig } from './config/load.ts';
import type { LoadedConfig } from './config/types.ts';
import { watchConfig } from './config/watch.ts';
import { defaultAgent, HttpError, postUserMessage } from './core/dispatch.ts';
import { serializeConversation, serializeMessage, serializeRun } from './core/serialize.ts';
import { openDb } from './db/migrate.ts';
import { Store } from './db/queries.ts';
import { Hub } from './hub.ts';
import { appRoot, resolvePaths, type Paths } from './paths.ts';
import { TurnRunner } from './runner/turn.ts';
import { compileGate, writeGate } from './gate/compile.ts';
import { classifyInventory, readToolList } from './gate/inventory.ts';
import { blocksOf } from './context/blocks.ts';
import { DirIndex } from './dirs/index.ts';
import { WorkflowEngine } from './core/workflows.ts';
import { Scheduler } from './scheduler/scheduler.ts';
import { searchMessages } from './core/search.ts';
import type { MessageRow, ThreadRow } from './db/queries.ts';

export interface DirService {
  isKnown(path: string): boolean;
}

export interface WorkflowService {
  start(opts: { workflow: string; thread: ThreadRow; trigger: MessageRow | null; cwd: string; mentions: unknown; input?: string }): { id: string };
}

export interface AppOptions {
  configDir?: string;
  dataDir?: string;
  /** Overrides config.port for the Host check (tests). */
  port?: number;
  watch?: boolean;
  /** Clock for the scheduler (tests). */
  now?: () => number;
}

export class AppContext {
  cfg: LoadedConfig;
  readonly store: Store;
  readonly hub = new Hub();
  readonly token: string;
  runner!: TurnRunner;
  dirs: DirService = { isKnown: () => false };
  workflows!: WorkflowEngine;
  scheduler!: Scheduler;
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
    agents: Object.values(cfg.agents).map((a) => ({ name: a.name, description: a.description, model: a.model, tools: a.tools, builtin: !!a.raw })),
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
    dirRoots: cfg.config.dirRoots,
    homeDir: os.homedir(),
    scratchDir: cfg.config.scratchDir,
    defaultModel: cfg.config.defaultModel,
  };
}

export function createApp(opts: AppOptions = {}) {
  const paths = resolvePaths(opts);
  const ctx = new AppContext(paths, opts);
  const { store, hub } = ctx;
  if (opts.watch !== false) ctx.startWatching();
  const syncGate = () => writeGate(paths.gateJson, compileGate(ctx.cfg.readonly));
  syncGate();
  ctx.onConfig(syncGate);
  ctx.runner = new TurnRunner(ctx);
  ctx.workflows = new WorkflowEngine(ctx);
  const scheduler = new Scheduler(ctx, opts.now);
  ctx.scheduler = scheduler;
  ctx.onStart(() => scheduler.start());
  ctx.addStop(() => scheduler.stop());
  const dirIndex = new DirIndex(ctx);
  ctx.dirs = dirIndex;
  dirIndex.rescan();
  ctx.onConfig(() => dirIndex.rescanIfRootsChanged());

  const app = new Hono();
  app.use('*', guard(ctx.token, () => ctx.port));

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : ((err as any).status ?? 500);
    if (status >= 500) console.error(err);
    return c.json({ error: err.message }, status);
  });

  /** Keeps the parent's thread badge (reply count, last activity) live. */
  function publishChildSummary(threadId: string) {
    const t = store.getThread(threadId);
    if (!t?.parent_thread_id) return;
    const sum = store.childThreadSummaries(t.parent_thread_id).find((x) => x.id === t.id);
    if (!sum) return;
    hub.thread(t.parent_thread_id, 'thread.created', {
      id: sum.id,
      parentMessageId: sum.parent_message_id,
      blockIndex: sum.block_index,
      replyCount: sum.reply_count,
      lastActivity: sum.last_activity ?? sum.created_at,
    });
  }
  hub.tap = (topic, event) => {
    if (topic.startsWith('thread:') && (event === 'message.created' || event === 'message.done')) publishChildSummary(topic.slice(7));
  };

  // ---- auth ----
  app.post('/api/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!tokenEquals(body.token, ctx.token)) return c.json({ error: 'bad token' }, 403);
    setCookie(c, COOKIE, ctx.token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return c.json({ ok: true });
  });
  app.get('/api/session', (c) => c.json({ ok: true }));
  // Unauthenticated identity check, used by a second start to detect an instance already running.
  const startedAt = Date.now();
  app.get('/api/health', (c) => c.json({ app: 'agent-chat', pid: process.pid, dataDir: paths.dataDir, startedAt }));

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
      runs: Object.fromEntries(
        [...new Set(store.listMessages(thread.id).map((m) => m.run_id).filter((x): x is string => !!x))]
          .map((id) => store.getRun(id))
          .filter((r) => !!r)
          .map((r) => [r!.id, serializeRun(r!)]),
      ),
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

  app.post('/api/runs/:id/retry', (c) => {
    ctx.workflows.retry(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/runs/:id/cancel', (c) => {
    ctx.workflows.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/messages/:id/cancel', (c) => {
    const msg = store.getMessage(c.req.param('id'));
    if (!msg) return c.json({ error: 'not found' }, 404);
    return c.json({ cancelled: ctx.runner.cancel(msg.id) });
  });

  // ---- gate ----
  app.get('/api/gate', (c) => {
    const gate = compileGate(ctx.cfg.readonly);
    let recent: unknown[] = [];
    try {
      const lines = fs.readFileSync(paths.hookLog, 'utf8').trim().split('\n').slice(-100);
      recent = lines.filter(Boolean).map((l) => JSON.parse(l)).reverse();
    } catch {
      // no log yet
    }
    return c.json({ gate, recent });
  });

  app.get('/api/gate/inventory', async (c) => {
    const dir = c.req.query('dir') || ctx.scratchDir();
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return c.json({ error: 'not a directory' }, 400);
    const { tools, mcpServers } = await readToolList(ctx.cfg.config.claudeBin, dir);
    return c.json({ dir, mcpServers, rows: classifyInventory(tools, compileGate(ctx.cfg.readonly)) });
  });

  // ---- search ----
  app.get('/api/search', (c) => c.json(searchMessages(store.db, c.req.query('q') ?? '')));

  // ---- routines ----
  app.get('/api/routines', (c) => c.json(scheduler.list()));
  app.post('/api/routines/:id/run', (c) => {
    const name = c.req.param('id');
    if (!ctx.cfg.routines[name]) return c.json({ error: 'unknown routine' }, 404);
    return c.json({ queued: scheduler.enqueue(name, true) });
  });
  app.post('/api/routines/:id/channel', (c) => {
    const r = ctx.cfg.routines[c.req.param('id')];
    if (!r) return c.json({ error: 'unknown routine' }, 404);
    return c.json({ conversationId: scheduler.ensureChannel(r).id });
  });

  // ---- directories ----
  app.get('/api/dirs', (c) => c.json(dirIndex.search(c.req.query('q') ?? '')));
  app.post('/api/dirs/rescan', (c) => c.json({ count: dirIndex.rescan() }));
  app.post('/api/dirs', async (c) => {
    const body = await c.req.json();
    const out = dirIndex.create(String(body.root ?? ''), String(body.name ?? '').trim(), body.git !== false);
    return c.json(out, out.created ? 201 : 200);
  });

  // ---- paragraph threads ----
  app.post('/api/threads', async (c) => {
    const body = await c.req.json();
    const msg = store.getMessage(String(body.message_id ?? ''));
    if (!msg) return c.json({ error: 'message not found' }, 404);
    if (msg.status !== 'done') return c.json({ error: 'threads can only start on finished messages' }, 400);
    const parent = store.getThread(msg.thread_id)!;
    if (parent.parent_thread_id) return c.json({ error: 'threads cannot be nested' }, 400);
    let blocks: string[];
    try {
      blocks = await blocksOf(msg.content_md);
    } catch {
      return c.json({ error: 'could not parse this message' }, 400);
    }
    const index = Number(body.block_index);
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return c.json({ error: 'no such paragraph' }, 400);
    const { thread, created } = store.upsertParagraphThread(msg, index, blocks[index]);
    if (created) publishChildSummary(thread.id);
    return c.json({ id: thread.id, conversationId: thread.conversation_id, created }, created ? 201 : 200);
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

/** Directories come only from the index (never a free-typed path); null clears it. */
export function validateDirInput(ctx: AppContext, dir: unknown): string | null {
  if (dir === null || dir === undefined || dir === '') return null;
  if (typeof dir !== 'string' || !ctx.dirs.isKnown(dir)) throw new HttpError(400, `unknown directory: ${String(dir)}`);
  return dir;
}
