import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config/load.ts';
import { makeApp, tmpDir, waitFor, writeFiles } from './helpers.ts';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const agent = (name: string, desc = 'd') => `---\nname: ${name}\ndescription: ${desc}\nmodel: haiku\n---\nYou are ${name}.\n`;

describe('config loader', () => {
  it('loads agents, workflows and routines and reports problems without throwing', () => {
    const dir = tmpDir();
    writeFiles(dir, {
      'config.yaml': 'claudeBin: ~/bin/claude-gw\nmaxConcurrent: 2\ndirRoots: [~/code]\n',
      'agents/researcher.md': agent('researcher'),
      'agents/writer.md': agent('writer'),
      'agents/bad.md': '---\nname: "has space"\n---\nx',
      'workflows/brief.yaml': 'name: brief\nsteps:\n  - agent: researcher\n    prompt: "{{input}}"\n  - agent: writer\n    prompt: go\n',
      'workflows/dup.yaml': 'name: researcher\nsteps:\n  - agent: writer\n    prompt: x\n',
      'workflows/unknown.yaml': 'name: u\nsteps:\n  - agent: nobody\n    prompt: x\n',
      'routines/standup.yaml': 'schedule: { daily: "07:00" }\ntarget: agent:researcher\nprompt: hi\n',
      'routines/badtime.yaml': 'schedule: { daily: "25:00" }\ntarget: agent:researcher\nprompt: hi\n',
    });
    const cfg = loadConfig(dir);
    expect(cfg.config.maxConcurrent).toBe(2);
    expect(cfg.config.claudeBin).not.toContain('~');
    expect(Object.keys(cfg.agents).sort()).toEqual(['claude', 'researcher', 'writer']);
    expect(Object.keys(cfg.workflows)).toEqual(['brief']);
    expect(cfg.routines.standup.channel).toBe('routine-standup');
    const files = cfg.problems.map((p) => p.file).sort();
    expect(files).toEqual(['agents/bad.md', 'routines/badtime.yaml', 'workflows/dup.yaml', 'workflows/unknown.yaml']);
  });

  it('reports invalid YAML in config.yaml and falls back to defaults', () => {
    const dir = tmpDir();
    writeFiles(dir, { 'config.yaml': 'port: [unclosed' });
    const cfg = loadConfig(dir);
    expect(cfg.config.port).toBe(4777);
    expect(cfg.problems[0].file).toBe('config.yaml');
  });

  it('hot-reloads /api/config when an agent file changes', async () => {
    const { ctx, call, configDir } = makeApp({ 'agents/researcher.md': agent('researcher', 'first') }, { watch: true });
    cleanup.push(() => ctx.close());
    expect((await call('GET', '/api/config')).body.agents.find((a: any) => a.name === 'researcher').description).toBe('first');
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(configDir, 'agents/researcher.md'), agent('researcher', 'second'));
    fs.writeFileSync(path.join(configDir, 'agents/writer.md'), agent('writer'));
    await waitFor(() => ctx.cfg.agents.writer && ctx.cfg.agents.researcher.description === 'second', 5000);
    const res = await call('GET', '/api/config');
    expect(res.body.agents.filter((a: any) => !a.builtin).map((a: any) => a.description).sort()).toEqual(['d', 'second']);
  });
});

describe('built-in neutral agent', () => {
  it('is always available as @claude, and a user file with that name replaces it', () => {
    const dir = tmpDir();
    const cfg = loadConfig(dir);
    expect(cfg.agents.claude.raw).toBe(true);
    expect(cfg.agents.claude.body).toBe('');
    writeFiles(dir, { 'agents/claude.md': agent('claude', 'mine') });
    const custom = loadConfig(dir);
    expect(custom.agents.claude.raw).toBeUndefined();
    expect(custom.agents.claude.description).toBe('mine');
  });

  it('shares the @ namespace with workflows', () => {
    const dir = tmpDir();
    writeFiles(dir, { 'workflows/claude.yaml': 'name: claude\nsteps:\n  - agent: claude\n    prompt: x\n' });
    const cfg = loadConfig(dir);
    expect(cfg.workflows.claude).toBeUndefined();
    expect(cfg.problems[0].message).toContain('already used');
  });
});
