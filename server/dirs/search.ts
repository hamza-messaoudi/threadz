import os from 'node:os';
import path from 'node:path';

export interface DirEntry {
  path: string;
  root: string | null;
  recentAt?: number;
}

/** Subsequence fuzzy score (higher is better), or -1 when the query does not match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  const base = path.basename(t);
  let score = 0;
  if (base === q) score += 100;
  else if (base.startsWith(q)) score += 60;
  else if (base.includes(q)) score += 40;
  else if (t.includes(q)) score += 20;
  let ti = 0;
  let run = 0;
  let matched = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return score > 0 ? score : -1;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2;
    if (found === 0 || '/-_. '.includes(t[found - 1])) score += 3;
    matched++;
    ti = found + 1;
  }
  return matched === q.length ? score - t.length * 0.01 : -1;
}

export function displayPath(p: string, root: string | null): string {
  if (root && p.startsWith(root)) return path.relative(path.dirname(root), p);
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function searchDirs(entries: DirEntry[], query: string, limit = 12): DirEntry[] {
  const now = Date.now();
  const scored = entries
    .map((e) => {
      let s = fuzzyScore(query.trim(), displayPath(e.path, e.root));
      if (s < 0) return null;
      if (e.recentAt) s += 30 + Math.max(0, 20 - (now - e.recentAt) / 86_400_000); // recent boost, fading over ~3 weeks
      return { e, s };
    })
    .filter((x): x is { e: DirEntry; s: number } => !!x)
    .sort((a, b) => b.s - a.s || a.e.path.localeCompare(b.e.path));
  return scored.slice(0, limit).map((x) => x.e);
}
