import { api, type DirResult } from './api.ts';

export const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function tildify(p: string, home: string | undefined): string {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Turns free text ("My new API") into a folder name suggestion ("my-new-api"). */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 60);
}

export interface CreateOption {
  root: string;
  name: string;
}

/** "New folder" rows offered when the query is a valid name that does not already exist in a root. */
export function createOptions(query: string, roots: string[], results: DirResult[]): CreateOption[] {
  const name = query.trim();
  if (!DIR_NAME_RE.test(name)) return [];
  return roots
    .filter((root) => !results.some((r) => r.path === `${root.replace(/\/+$/, '')}/${name}`))
    .map((root) => ({ root, name }));
}

/** Put "New folder" first when nothing found is a close match (fuzzy results can be loose). */
export function createFirst(query: string, results: DirResult[]): boolean {
  const q = query.trim().toLowerCase();
  return !!q && !results.some((r) => r.name.toLowerCase().includes(q));
}

export function createDir(opt: CreateOption): Promise<DirResult & { created: boolean }> {
  return api.post('/api/dirs', { root: opt.root, name: opt.name, git: true });
}
