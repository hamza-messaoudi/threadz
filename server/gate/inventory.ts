import { spawn } from 'node:child_process';
import { childEnv } from '../runner/spawn.ts';
import { classify, type GateConfig } from './classify.ts';

export interface InventoryRow {
  tool: string;
  allow: boolean;
  rule: string;
  reason: string;
}

/**
 * Starts Claude in `dir`, reads the tool list from the init event and kills the process group right
 * away. Claude needs a prompt before it emits init, so at most one tiny model call may start (NOTES.md).
 */
export function readToolList(bin: string, dir: string, timeoutMs = 60000): Promise<{ tools: string[]; mcpServers: { name: string; status: string }[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], {
      cwd: dir,
      env: childEnv({}),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let done = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // gone
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      kill();
      reject(new Error('timed out waiting for the init event'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'system' && ev.subtype === 'init' && !done) {
          done = true;
          kill();
          clearTimeout(timer);
          resolve({ tools: ev.tools ?? [], mcpServers: (ev.mcp_servers ?? []).map((s: any) => ({ name: s.name, status: s.status })) });
        }
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`claude exited before init: ${stderr.trim()}`));
      }
    });
    child.stdin.end('Reply with: ok');
  });
}

export function classifyInventory(tools: string[], gate: GateConfig): InventoryRow[] {
  return tools
    .map((tool) =>
      tool === 'Bash'
        ? { tool, allow: true, rule: 'bash: per-command allowlist', reason: 'read commands only' }
        : { tool, ...classify(tool, {}, { mode: 'readonly', agentTools: [], gate }) },
    )
    .map((d) => ({ tool: d.tool, allow: d.allow, rule: d.rule, reason: d.reason }))
    .sort((a, b) => Number(a.tool.startsWith('mcp__')) - Number(b.tool.startsWith('mcp__')) || a.tool.localeCompare(b.tool));
}
