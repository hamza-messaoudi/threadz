import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appRoot } from '../paths.ts';
import { StreamParser, type RunnerEvent } from './parse.ts';

export interface SpawnAgent {
  /** Omitted = Claude Code's own default model. */
  model?: string;
  /** Omitted or empty = no --append-system-prompt. */
  systemPrompt?: string;
  /** `graphs`: append the figure catalog (server/prompts/comark-graphs.md) after the agent body. */
  render?: 'graphs';
}

let graphsPrompt: string | null = null;
/** The figure catalog, read once. Constant text, so prompt caching works as usual. */
export function comarkGraphsPrompt(): string {
  return (graphsPrompt ??= fs.readFileSync(path.join(appRoot, 'server', 'prompts', 'comark-graphs.md'), 'utf8').trim());
}

function systemPromptOf(agent: SpawnAgent): string {
  return [agent.systemPrompt, agent.render === 'graphs' ? comarkGraphsPrompt() : ''].filter((p) => p && p.trim()).join('\n\n');
}

export interface SessionArgs {
  resume?: string;
  fork?: boolean;
}

export interface SpawnMode {
  settingsPath: string;
  partial: boolean;
}

/**
 * Pure and order-stable: identical inputs give byte-identical flags (hard rule 1). Everything that
 * varies per turn goes in env or the prompt, never here. Only --resume/--fork-session vary.
 */
export function buildArgs(agent: SpawnAgent, session: SessionArgs, mode: SpawnMode): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (mode.partial) args.push('--include-partial-messages');
  if (agent.model) args.push('--model', agent.model);
  const system = systemPromptOf(agent);
  if (system) args.push('--append-system-prompt', system);
  args.push('--settings', mode.settingsPath, '--permission-mode', 'bypassPermissions');
  if (session.resume) {
    args.push('--resume', session.resume);
    if (session.fork) args.push('--fork-session');
  }
  return args;
}

/** Hash of everything that must stay identical for a session to keep its cache. */
export function flagsHash(claudeBin: string, agent: SpawnAgent, mode: SpawnMode, cwd: string): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([claudeBin, buildArgs(agent, {}, mode), cwd]))
    .digest('hex')
    .slice(0, 16);
}

// Inherited from a parent Claude Code session; they would confuse the child CLI.
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];

export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return { ...env, ...extra };
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  spawnError?: string;
}

export interface TurnProcess {
  pid?: number;
  done: Promise<SpawnResult>;
  cancel(): void;
}

const STDERR_TAIL = 4096;

export function spawnClaude(opts: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  onEvent: (e: RunnerEvent) => void;
}): TurnProcess {
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group, so cancel can kill MCP children too
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parser = new StreamParser(opts.onEvent);
  let stderr = '';
  let spawnError: string | undefined;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => parser.feed(d));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr = (stderr + d).slice(-STDERR_TAIL);
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(opts.prompt);

  const done = new Promise<SpawnResult>((resolve) => {
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      parser.end();
      resolve({ code, signal, stderrTail: stderr, spawnError });
    });
  });

  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };

  return {
    pid: child.pid,
    done,
    cancel() {
      killGroup('SIGTERM');
      const t = setTimeout(() => killGroup('SIGKILL'), 3000);
      t.unref();
      done.then(() => clearTimeout(t));
    },
  };
}
