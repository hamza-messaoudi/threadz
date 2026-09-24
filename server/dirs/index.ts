import path from 'node:path';
import type { AppContext, DirService } from '../app.ts';
import { gitBranch, scanDirs, type ScannedDir } from './scan.ts';
import { searchDirs, type DirEntry } from './search.ts';

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
    return searchDirs(this.entries(), q).map((e) => ({
      path: e.path,
      name: path.basename(e.path),
      root: e.root,
      branch: gitBranch(e.path),
      recent: !!e.recentAt,
    }));
  }
}
