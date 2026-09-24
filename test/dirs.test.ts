import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDirs } from '../server/dirs/scan.ts';
import { fuzzyScore, searchDirs } from '../server/dirs/search.ts';
import { agentFile, makeFakeApp, tmpDir } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

function tree(root: string, dirs: Record<string, string[]>) {
  for (const [d, markers] of Object.entries(dirs)) {
    const p = path.join(root, d);
    fs.mkdirSync(p, { recursive: true });
    for (const m of markers) {
      if (m.endsWith('/')) fs.mkdirSync(path.join(p, m), { recursive: true });
      else fs.writeFileSync(path.join(p, m), '');
    }
  }
}

describe('directory scan', () => {
  it('respects depth, skips node_modules and hidden folders, detects projects by marker files', () => {
    const root = tmpDir();
    tree(root, {
      'api': ['.git/'],
      'web': ['package.json'],
      'py': ['pyproject.toml'],
      'goapp': ['go.mod'],
      'rust': ['Cargo.toml'],
      'dotnet': ['App.sln'],
      'agentish': ['.claude/'],
      'plain': ['README.md'],
      'group/inner': ['package.json'],
      'group/deeper/too-deep': ['package.json'],
      'web/node_modules/lib': ['package.json'],
      '.hidden/proj': ['package.json'],
    });
    const found = scanDirs([root], 2).map((d) => path.relative(root, d.path)).sort();
    expect(found).toEqual(['agentish', 'api', 'dotnet', 'goapp', 'group/inner', 'py', 'rust', 'web']);
    expect(scanDirs([root], 1).map((d) => path.relative(root, d.path))).not.toContain('group/inner');
  });
});

describe('directory search', () => {
  it('fuzzy matches with recent directories boosted', () => {
    expect(fuzzyScore('mr', 'code/main-repo')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'code/main-repo')).toBe(-1);
    const entries = [
      { path: '/c/main-repo', root: '/c' },
      { path: '/c/other-repo', root: '/c' },
      { path: '/c/repo-tools', root: '/c', recentAt: Date.now() },
    ];
    expect(searchDirs(entries, 'main')[0].path).toBe('/c/main-repo');
    expect(searchDirs(entries, 'repo')[0].path).toBe('/c/repo-tools');
    expect(searchDirs(entries, '').length).toBe(3);
  });
});

describe('dir mentions', () => {
  it('runs in the tagged directory and rejects directories not in the index', async () => {
    const root = tmpDir();
    tree(root, { 'other-repo': ['.git/'] });
    const t = makeFakeApp({ 'agents/r.md': agentFile('r') }, { dirRoots: [root] });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const other = path.join(root, 'other-repo');
    const res = (await t.call('GET', '/api/dirs?q=other')).body;
    expect(res[0].path).toBe(other);

    const bad = await t.call('POST', `/api/threads/${ch.rootThreadId}/messages`, {
      text: '@r #etc hi',
      mentions: [{ kind: 'agent', id: 'r', start: 0, end: 2 }, { kind: 'dir', id: '/etc', start: 3, end: 7 }],
    });
    expect(bad.status).toBe(400);

    const r = await t.post(ch.rootThreadId, '@r #other-repo what is this?', [
      { kind: 'agent', id: 'r', start: 0, end: 2 },
      { kind: 'dir', id: other, start: 3, end: 14 },
    ]);
    const m = await t.settled(r.agentMessageIds[0]);
    expect(fs.realpathSync(t.calls()[0].cwd)).toBe(fs.realpathSync(other));
    expect(JSON.parse(m.markers!)).toEqual(['new session in other-repo']);
    expect(t.ctx.store.recentDirs()[0].path).toBe(other);
  });
});

describe('creating folders', () => {
  it('creates a folder with git init in a configured root and makes it taggable', async () => {
    const root = tmpDir();
    const t = makeFakeApp({ 'agents/r.md': agentFile('r') }, { dirRoots: [root] });
    cleanup.push(() => t.ctx.close());
    const res = await t.call('POST', '/api/dirs', { root, name: 'fresh-api' });
    expect(res.status).toBe(201);
    const p = path.join(root, 'fresh-api');
    expect(res.body).toMatchObject({ path: p, name: 'fresh-api', created: true });
    expect(fs.existsSync(path.join(p, '.git'))).toBe(true);
    expect(t.ctx.dirs.isKnown(p)).toBe(true);
    expect((await t.call('GET', '/api/dirs?q=fresh')).body[0].path).toBe(p);

    // Usable at once as a channel dir and as a #dir mention.
    expect((await t.call('POST', '/api/conversations', { kind: 'channel', name: 'fresh', dir: p })).status).toBe(201);
    // Existing folder: just returned.
    expect((await t.call('POST', '/api/dirs', { root, name: 'fresh-api' })).status).toBe(200);
  });

  it('refuses folders outside dirRoots and unsafe names', async () => {
    const root = tmpDir();
    const t = makeFakeApp({}, { dirRoots: [root] });
    cleanup.push(() => t.ctx.close());
    expect((await t.call('POST', '/api/dirs', { root: tmpDir(), name: 'x' })).status).toBe(400);
    for (const name of ['../escape', 'a/b', '.hidden', '', 'x'.repeat(101), 'sp ace']) {
      expect((await t.call('POST', '/api/dirs', { root, name })).status).toBe(400);
    }
    expect(fs.readdirSync(root)).toEqual([]);
    fs.writeFileSync(path.join(root, 'afile'), '');
    expect((await t.call('POST', '/api/dirs', { root, name: 'afile' })).status).toBe(409);
  });
});
