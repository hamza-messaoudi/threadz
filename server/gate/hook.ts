// PreToolUse hook registered by gate-settings.json (matcher "*"). Bundled to dist/hook.mjs.
// Exit 0 = allow, exit 2 = deny with the reason on stderr (the model sees it).
// Fails closed: any error, unreadable config or missing AGENT_MODE exits 2 (exit 1 would NOT block).
import fs from 'node:fs';
import { classify, type Decision, type GateConfig } from './classify.ts';

function main(raw: string): number {
  let decision: Decision;
  let tool = '?';
  let input: any = null;
  try {
    const payload = JSON.parse(raw);
    tool = String(payload.tool_name ?? '?');
    input = payload.tool_input;
    const mode = process.env.AGENT_MODE;
    if (mode !== 'readonly' && mode !== 'yolo') throw new Error('AGENT_MODE is not set');
    const gate = JSON.parse(fs.readFileSync(process.env.AGENT_CHAT_GATE_CONFIG ?? '', 'utf8')) as GateConfig;
    const agentTools = JSON.parse(process.env.AGENT_TOOLS || '[]');
    if (!Array.isArray(agentTools)) throw new Error('AGENT_TOOLS is not a list');
    if (process.env.AGENT_CHAT_HOOK_TEST_THROW) throw new Error('test: forced failure');
    decision = classify(tool, input, { mode, agentTools, gate, cwd: payload.cwd });
  } catch (e: any) {
    decision = { allow: false, rule: 'hook error', reason: `gate error, blocking to be safe: ${e?.message ?? e}` };
  }
  try {
    const log = process.env.AGENT_CHAT_HOOK_LOG;
    if (log) {
      const entry = {
        t: Date.now(),
        run: process.env.AGENT_CHAT_RUN_ID ?? null,
        mode: process.env.AGENT_MODE ?? null,
        tool,
        input: JSON.stringify(input ?? null).slice(0, 500),
        allow: decision.allow,
        rule: decision.rule,
      };
      fs.appendFileSync(log, JSON.stringify(entry) + '\n');
    }
  } catch {
    // logging must never turn a deny into an allow, nor crash
  }
  if (decision.allow) return 0;
  process.stderr.write(decision.reason + '\n');
  return 2;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  let code = 2;
  try {
    code = main(buf);
  } catch {
    process.stderr.write('gate error, blocking to be safe\n');
  }
  process.exit(code);
});
process.stdin.on('error', () => process.exit(2));
