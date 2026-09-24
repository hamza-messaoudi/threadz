import fs from 'node:fs';
import path from 'node:path';

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', '.claude'];
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__', 'venv']);

export interface ScannedDir {
  path: string;
  root: string;
}

function isProject(dir: string, entries: fs.Dirent[]): boolean {
  return entries.some((e) => MARKERS.includes(e.name) || (e.isFile() && e.name.endsWith('.sln')));
}

/** Walks each root to `depth` levels and keeps folders that look like projects. */
export function scanDirs(roots: string[], depth: number): ScannedDir[] {
  const out: ScannedDir[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, root: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable
    }
    if (isProject(dir, entries) && !seen.has(dir)) {
      seen.add(dir);
      out.push({ path: dir, root });
    }
    if (level >= depth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), root, level + 1);
    }
  };
  for (const r of roots) {
    const root = path.resolve(r);
    if (fs.existsSync(root)) walk(root, root, 0);
  }
  return out;
}

/** Current branch from .git/HEAD, or null. Cheap: one small file read. */
export function gitBranch(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}
