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
  async function setup() {
    const root = tmpDir();
    tree(root, { 'other-repo': ['.git/'] });
    const t = makeFakeApp({ 'agents/r.md': agentFile('r') }, { dirRoots: [root] });
    cleanup.push(() => t.ctx.close());
    const ch = await t.channel();
    const other = path.join(root, 'other-repo');
    expect((await t.call('GET', '/api/dirs?q=other')).body[0].path).toBe(other);
    const say = async (text: string, dir?: { kind: 'dir' | 'cd'; id: string }) => {
      const at = text.indexOf('#');
      const res = await t.post(ch.rootThreadId, text, [{ kind: 'agent', id: 'r', start: 0, end: 2 }, ...(dir ? [{ ...dir, start: at, end: text.length }] : [])]);
      return t.settled(res.agentMessageIds[0]);
    };
    return { t, ch, other, say };
  }

  it('rejects directories that are not in the index', async () => {
    const { t, ch } = await setup();
    for (const kind of ['dir', 'cd'])
      expect(
        (await t.call('POST', `/api/threads/${ch.rootThreadId}/messages`, { text: '@r #etc hi', mentions: [{ kind: 'agent', id: 'r', start: 0, end: 2 }, { kind, id: '/etc', start: 3, end: 7 }] })).status,
      ).toBe(400);
  });

  it('a reference keeps the session and directory and names the path in the prompt', async () => {
    const { t, other, say } = await setup();
    const first = await say('@r hello');
    const m = await say('@r compare with #other-repo', { kind: 'dir', id: other });
    const call = t.calls()[1];
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(first.cwd!));
    expect(call.argv.slice(-2)).toEqual(['--resume', first.session_id]);
    expect(call.stdin).toContain(`<referenced_directories>`);
    expect(call.stdin).toContain(`- ${other}`);
    expect(m.markers).toBeNull();
    expect(t.ctx.store.recentDirs()[0].path).toBe(other);
  });

  it('a move is sticky for the thread and carries the session over', async () => {
    const { t, ch, other, say } = await setup();
    const first = await say('@r hello');
    const moved = await say('@r work in #other-repo', { kind: 'cd', id: other });
    const call = t.calls()[1];
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(other));
    expect(call.argv.slice(-3)).toEqual(['--resume', first.session_id, '--fork-session']);
    expect(call.stdin).toContain('<working_directory_changed>');
    expect(JSON.parse(moved.markers!)).toEqual(['moved to other-repo, session carried over']);
    const thread = (await t.call('GET', `/api/threads/${ch.rootThreadId}`)).body;
    expect(thread.thread.cwd).toBe(other);
    expect(thread.messages.some((x: any) => x.authorKind === 'system' && x.meta?.kind === 'moved')).toBe(true);

    // Untagged follow-up: still in the new directory, resuming the carried-over session.
    const next = await say('@r and now?');
    expect(fs.realpathSync(t.calls()[2].cwd)).toBe(fs.realpathSync(other));
    expect(t.calls()[2].argv.slice(-2)).toEqual(['--resume', moved.session_id]);
    expect(next.cwd).toBe(other);

    // A side thread on a message follows where that message ran, and forks its session.
    const side = (await t.call('POST', '/api/threads', { message_id: next.id, block_index: 0 })).body;
    const sr = await t.post(side.id, 'why?');
    await t.settled(sr.agentMessageIds[0]);
    expect(fs.realpathSync(t.calls()[3].cwd)).toBe(fs.realpathSync(other));
    expect(t.calls()[3].argv.slice(-3)).toEqual(['--resume', next.session_id, '--fork-session']);

    // Moving back (the header's "back" button) resumes the session that was left behind.
    expect((await t.call('PATCH', `/api/threads/${ch.rootThreadId}`, { dir: null })).body.cwd).toBe(first.cwd);
    await say('@r back home');
    expect(fs.realpathSync(t.calls()[4].cwd)).toBe(fs.realpathSync(first.cwd!));
    expect(t.calls()[4].argv.slice(-2)).toEqual(['--resume', first.session_id]);
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
