import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import {
  ConfigError,
  DEFAULT_CONFIG,
  validateAgent,
  validateAppConfig,
  validateReadonly,
  validateRoutine,
  validateWorkflow,
} from './validate.ts';
import type { LoadedConfig } from './types.ts';

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => exts.includes(path.extname(f).toLowerCase()) && !f.startsWith('.'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const baseName = (f: string) => path.basename(f, path.extname(f));

function readYaml(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new ConfigError(doc.errors[0].message.split('\n')[0]);
  return doc.toJS();
}

/** Reads every config file. Never throws: invalid files are reported in `problems` and skipped. */
export function loadConfig(configDir: string): LoadedConfig {
  const out: LoadedConfig = {
    config: { ...DEFAULT_CONFIG },
    agents: {},
    workflows: {},
    routines: {},
    readonly: validateReadonly(undefined),
    problems: [],
  };
  const problem = (file: string, e: unknown) =>
    out.problems.push({ file: path.relative(configDir, file) || file, message: e instanceof Error ? e.message : String(e) });

  const configFile = path.join(configDir, 'config.yaml');
  try {
    out.config = validateAppConfig(readYaml(configFile));
  } catch (e) {
    problem(configFile, e);
  }

  const readonlyFile = path.join(configDir, 'readonly.yaml');
  try {
    out.readonly = validateReadonly(readYaml(readonlyFile));
  } catch (e) {
    problem(readonlyFile, e);
  }

  // `@` namespace shared by agents and workflows; duplicates are a config error.
  const owners = new Map<string, string>();
  const claim = (name: string, file: string) => {
    const prev = owners.get(name.toLowerCase());
    if (prev) throw new ConfigError(`name "@${name}" is already used by ${path.relative(configDir, prev)}`);
    owners.set(name.toLowerCase(), file);
  };

  for (const file of listFiles(path.join(configDir, 'agents'), ['.md'])) {
    try {
      const parsed = matter(fs.readFileSync(file, 'utf8'));
      const agent = validateAgent(parsed.data, parsed.content, file, baseName(file));
      claim(agent.name, file);
      out.agents[agent.name] = agent;
    } catch (e) {
      problem(file, e);
    }
  }

  for (const file of listFiles(path.join(configDir, 'workflows'), ['.yaml', '.yml'])) {
    try {
      const wf = validateWorkflow(readYaml(file), file, baseName(file));
      for (const s of wf.steps) if (!out.agents[s.agent]) throw new ConfigError(`step uses unknown agent "${s.agent}"`);
      claim(wf.name, file);
      out.workflows[wf.name] = wf;
    } catch (e) {
      problem(file, e);
    }
  }

  for (const file of listFiles(path.join(configDir, 'routines'), ['.yaml', '.yml'])) {
    try {
      const r = validateRoutine(readYaml(file), file, baseName(file));
      if (out.routines[r.name]) throw new ConfigError(`duplicate routine name "${r.name}"`);
      const exists = r.target.kind === 'agent' ? out.agents[r.target.id] : out.workflows[r.target.id];
      if (!exists) throw new ConfigError(`unknown target ${r.target.kind}:${r.target.id}`);
      out.routines[r.name] = r;
    } catch (e) {
      problem(file, e);
    }
  }

  return out;
}
