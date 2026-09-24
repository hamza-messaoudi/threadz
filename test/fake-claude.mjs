#!/usr/bin/env node
// Fake `claude -p` for tests. Speaks the stream-json protocol recorded in test/fixtures/stream.
//
// env FAKE_CLAUDE_STATE  directory for the call log (calls.jsonl) and the known-session list
// env FAKE_FIXTURE       replay test/fixtures/stream/<name>.jsonl instead of a synthetic reply
// Directives, read from --append-system-prompt (agent body) or the prompt text:
//   FAKE_DELAY=<ms>   wait before replying        FAKE_REPLY=<text>  reply text
//   FAKE_FAIL         exit 1 with an error result FAKE_TOOL=<name>   emit one tool call first
//   FAKE_HANG         never finish (for cancel tests)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const stateDir = process.env.FAKE_CLAUDE_STATE ?? path.join(process.cwd(), '.fake-claude');
fs.mkdirSync(stateDir, { recursive: true });
const sessionsFile = path.join(stateDir, 'sessions.json');
const readSessions = () => {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  } catch {
    return [];
  }
};

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', main);

process.on('SIGTERM', () => process.exit(143));

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const system = flag('--append-system-prompt') ?? '';
  const directives = system + '\n' + stdin;
  const directive = (name) => {
    const m = new RegExp(`${name}=([^\\n]*)`).exec(directives);
    return m ? m[1].trim() : undefined;
  };
  const resume = flag('--resume');
  const fork = has('--fork-session');

  let sessionId;
  const known = readSessions();
  if (resume && !known.includes(resume)) {
    logCall({ sessionId: resume, error: 'missing' });
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resume, errors: [`No conversation found with session ID: ${resume}`], usage: {} });
    process.exit(1);
  }
  if (resume && !fork) sessionId = resume;
  else {
    sessionId = `fake-${known.length + 1}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(sessionsFile, JSON.stringify([...known, sessionId]));
  }
  logCall({ sessionId });

  if (process.env.FAKE_FIXTURE) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lines = fs.readFileSync(path.join(here, 'fixtures', 'stream', `${process.env.FAKE_FIXTURE}.jsonl`), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.session_id) ev.session_id = sessionId;
      out(ev);
    }
    return;
  }

  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: flag('--model'), tools: ['Read', 'Write', 'Bash'], mcp_servers: [] });
  const usage = resume
    ? { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 50 }
    : { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 };
  const msgId = `msg_${crypto.randomBytes(4).toString('hex')}`;
  const partial = has('--include-partial-messages');

  const delay = Number(directive('FAKE_DELAY') ?? 0);
  if (delay) await sleep(delay);
  if (/FAKE_HANG/.test(directives)) await sleep(60_000);

  if (/FAKE_FAIL/.test(directives)) {
    process.stderr.write('fake failure requested\n');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, errors: ['fake failure'], usage });
    process.exit(1);
  }

  const tool = directive('FAKE_TOOL');
  if (tool) {
    out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { id: `${msgId}_t`, content: [{ type: 'tool_use', id: 'toolu_fake1', name: tool, input: { file_path: 'x.txt' } }], usage } });
    out({ type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fake1', content: 'tool output', is_error: false }] } });
  }

  const lastMessage = /<message from="[^"]*">\n([\s\S]*?)\n<\/message>\s*$/.exec(stdin);
  const reply = directive('FAKE_REPLY') ?? `ack: ${(lastMessage ? lastMessage[1] : stdin).slice(0, 60)}`;
  if (partial) {
    out({ type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, event: { type: 'message_start', message: { id: msgId, usage } } });
    for (const chunk of reply.match(/.{1,8}/gs) ?? []) {
      out({ type: 'stream_event', parent_tool_use_id: null, session_id: sessionId, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
      await sleep(2);
    }
  }
  out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, message: { id: msgId, content: [{ type: 'text', text: reply }], usage } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: reply, usage: { ...usage, output_tokens: 5 }, total_cost_usd: 0 });
}

function logCall(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AGENT_')));
  fs.appendFileSync(path.join(stateDir, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), env, stdin, time: Date.now(), ...extra }) + '\n');
}
