import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../core/dispatch.ts';
import type { AppContext, DirService } from '../app.ts';
import { gitBranch, scanDirs, type ScannedDir } from './scan.ts';
import { searchDirs, type DirEntry } from './search.ts';

export const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** In-memory directory index: scanned project folders + channel dirs + recently used dirs. */
export class DirIndex implements DirService {
  private scanned: ScannedDir[] = [];
  private rootsKey = '';

  constructor(private readonly ctx: AppContext) {}

  rescan(): number {
    const { dirRoots, dirScanDepth } = this.ctx.cfg.config;
    this.scanned = scanDirs(dirRoots, dirScanDepth);
    this.rootsKey = JSON.stringify([dirRoots, dirScanDepth]);
    this.ctx.hub.global('dirs.changed', { count: this.scanned.length });
    return this.scanned.length;
  }

  rescanIfRootsChanged(): void {
    const { dirRoots, dirScanDepth } = this.ctx.cfg.config;
    if (JSON.stringify([dirRoots, dirScanDepth]) !== this.rootsKey) this.rescan();
  }

  entries(): DirEntry[] {
    const map = new Map<string, DirEntry>();
    for (const d of this.scanned) map.set(d.path, { path: d.path, root: d.root });
    for (const d of this.ctx.store.channelDirs()) if (!map.has(d)) map.set(d, { path: d, root: null });
    for (const r of this.ctx.store.recentDirs()) {
      const e = map.get(r.path) ?? { path: r.path, root: null };
      e.recentAt = r.used_at;
      map.set(r.path, e);
    }
    return [...map.values()];
  }

  isKnown(p: string): boolean {
    return this.entries().some((e) => e.path === p);
  }

  search(q: string) {
    return searchDirs(this.entries(), q).map((e) => this.describe(e.path, e.root, !!e.recentAt));
  }

  private describe(p: string, root: string | null, recent: boolean) {
    return { path: p, name: path.basename(p), root, branch: gitBranch(p), recent };
  }

  /**
   * Creates `<root>/<name>` inside one of the configured dirRoots (optionally `git init`), adds it to
   * the index and marks it recent. An existing folder is simply added.
   */
  create(root: string, name: string, git: boolean) {
    const roots = this.ctx.cfg.config.dirRoots.map((r) => path.resolve(r));
    const resolvedRoot = path.resolve(root);
    if (!roots.includes(resolvedRoot)) throw new HttpError(400, 'new folders can only be created in a configured dirRoots folder');
    if (!DIR_NAME_RE.test(name)) throw new HttpError(400, 'use letters, digits, ".", "-" or "_" (no slashes, not starting with a dot)');
    const target = path.join(resolvedRoot, name);
    let created = false;
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isDirectory()) throw new HttpError(409, `${target} exists and is not a folder`);
    } else {
      fs.mkdirSync(target);
      created = true;
    }
    if (git && !fs.existsSync(path.join(target, '.git'))) {
      try {
        execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore', timeout: 10000 });
      } catch {
        // git missing: the folder still works, it is just not a repo
      }
    }
    if (!this.scanned.some((d) => d.path === target)) this.scanned.push({ path: target, root: resolvedRoot });
    this.ctx.store.touchDir(target);
    this.ctx.hub.global('dirs.changed', { count: this.scanned.length });
    return { ...this.describe(target, resolvedRoot, true), created };
  }
}
