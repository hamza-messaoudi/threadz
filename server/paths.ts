import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function findAppRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('cannot find app root');
    dir = up;
  }
  return dir;
}

export const appRoot = findAppRoot();

export interface Paths {
  configDir: string;
  dataDir: string;
  dbFile: string;
  tokenFile: string;
  hookLog: string;
  gateJson: string;
  gateSettings: string;
  hookScript: string;
}

export function resolvePaths(opts: { configDir?: string; dataDir?: string } = {}): Paths {
  const configDir = opts.configDir ?? process.env.AGENT_CHAT_CONFIG_DIR ?? expandHome('~/.config/agent-chat');
  const dataDir = opts.dataDir ?? process.env.AGENT_CHAT_DATA_DIR ?? expandHome('~/.local/share/agent-chat');
  return {
    configDir,
    dataDir,
    dbFile: path.join(dataDir, 'agent-chat.db'),
    tokenFile: path.join(dataDir, 'token'),
    hookLog: path.join(dataDir, 'hook.log'),
    gateJson: path.join(dataDir, 'gate.json'),
    gateSettings: path.join(dataDir, 'gate-settings.json'),
    hookScript: path.join(appRoot, 'dist', 'hook.mjs'),
  };
}
