import picomatch from 'picomatch';
import { parse as shellParse } from 'shell-quote';

/** Compiled gate config (gate.json), produced by the server from the defaults plus readonly.yaml. */
export interface GateConfig {
  builtinAllow: string[];
  builtinDeny: string[];
  servers: Record<string, string>;
  allow: string[];
  deny: string[];
  bashExtraAllow: string[];
}

export interface Decision {
  allow: boolean;
  reason: string;
  rule: string;
}

export interface ClassifyOptions {
  mode: 'readonly' | 'yolo';
  agentTools: string[];
  gate: GateConfig;
  cwd?: string;
}

const allow = (rule: string, reason = 'allowed'): Decision => ({ allow: true, reason, rule });
const deny = (rule: string, reason: string): Decision => ({ allow: false, reason, rule });
const YOLO_HINT = 'Ask the user to switch on YOLO for this conversation if the change is needed.';

const matchAny = (name: string, globs: string[]) => globs.some((g) => (g === name ? true : picomatch.isMatch(name, g, { nocase: false })));

export function classify(toolName: string, input: unknown, opts: ClassifyOptions): Decision {
  // The agent's own `tools` list applies in both modes. ToolSearch is needed to load deferred MCP tools.
  if (opts.agentTools.length && toolName !== 'ToolSearch' && !matchAny(toolName, opts.agentTools)) {
    return deny('agent tools list', `${toolName} is not in this agent's tools list.`);
  }
  if (opts.mode === 'yolo') return allow('yolo');
  if (opts.mode !== 'readonly') return deny('mode', 'gate misconfigured: unknown AGENT_MODE');
  return classifyReadonly(toolName, input, opts.gate, opts.cwd);
}

export function classifyReadonly(toolName: string, input: unknown, gate: GateConfig, cwd?: string): Decision {
  // 1. Explicit overrides; deny wins.
  if (matchAny(toolName, gate.deny)) return deny('readonly.yaml deny', `read-only mode: ${toolName} is denied by readonly.yaml. ${YOLO_HINT}`);
  if (matchAny(toolName, gate.allow)) return allow('readonly.yaml allow');

  // 3. MCP tools by server profile.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return classifyMcp(mcp[1], mcp[2], input, gate);

  // 4. Bash.
  if (toolName === 'Bash') {
    const command = typeof (input as any)?.command === 'string' ? (input as any).command : '';
    return classifyBash(command, gate.bashExtraAllow, cwd);
  }

  // 2. Built-ins.
  if (gate.builtinAllow.includes(toolName)) return allow('built-in read tool');
  return deny('built-in', `read-only mode: ${toolName} can change things and is blocked. ${YOLO_HINT}`);
}

// ---------------------------------------------------------------------------------------------
// MCP profiles

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function profileFor(server: string, servers: Record<string, string>): string | null {
  for (const [name, profile] of Object.entries(servers)) {
    if (name === server || sanitize(name) === server) return profile === 'none' ? null : profile;
  }
  if (/github/i.test(server)) return 'github';
  if (/(^|[^a-z])ado([^a-z]|$)|azure|devops/i.test(server)) return 'azure-devops';
  return null;
}

const ADO_WRITE_VERBS = new Set(['create', 'update', 'add', 'delete', 'link', 'unlink', 'vote', 'reply', 'run', 'queue', 'upsert']);
const ADO_EXPLICIT_DENY = new Set(['repo_create_branch', 'wiki_upsert_page']);

function classifyMcp(server: string, tool: string, input: unknown, gate: GateConfig): Decision {
  const profile = profileFor(server, gate.servers);
  if (profile === 'github') return githubRule(tool);
  if (profile === 'azure-devops') return adoRule(tool, input);
  return deny('unknown MCP server', `read-only mode: MCP server "${server}" has no read-only profile, so its tools are blocked. Add it to readonly.yaml to allow reads.`);
}

export function githubRule(tool: string): Decision {
  if (tool === 'get_me' || /^(get|list|search)_/.test(tool) || /_read$/.test(tool)) return allow('github profile: read');
  return deny('github profile', `read-only mode: GitHub tool ${tool} can write and is blocked. ${YOLO_HINT}`);
}

export function adoRule(tool: string, input: unknown): Decision {
  const words = tool.toLowerCase().split('_');
  if (tool.endsWith('_write') || ADO_EXPLICIT_DENY.has(tool) || ADO_WRITE_VERBS.has(words[0]) || ADO_WRITE_VERBS.has(words[1] ?? '')) {
    return deny('azure-devops profile', `read-only mode: Azure DevOps tool ${tool} can write and is blocked. ${YOLO_HINT}`);
  }
  const action = (input as any)?.action;
  if (action !== undefined) {
    const a = String(action);
    if (!/^(get|list|show)/i.test(a) && !['search', 'my', 'download'].includes(a.toLowerCase())) {
      return deny('azure-devops action', `read-only mode: action "${a}" of ${tool} is not a read action. ${YOLO_HINT}`);
    }
  }
  return allow('azure-devops profile: read');
}

// ---------------------------------------------------------------------------------------------
// Bash

const SHELL_READS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'pwd', 'tree', 'jq', 'stat', 'file', 'du', 'which', 'echo', 'find']);
const FIND_DENY = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const GIT_SIMPLE = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files']);

const GH_ALLOWED: Record<string, string[] | '*'> = {
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  run: ['view', 'list'],
  workflow: ['view', 'list'],
  release: ['view', 'list'],
  search: '*',
  label: ['list'],
  auth: ['status'],
};

const AZ_PATTERNS: RegExp[] = [
  /^devops (project|team|user) (list|show)$/,
  /^repos (list|show)$/,
  /^repos pr (list|show)$/,
  /^repos pr reviewer list$/,
  /^repos pr work-item list$/,
  /^repos ref list$/,
  /^boards work-item show$/,
  /^boards query$/,
  /^boards (iteration|area)( [a-z-]+)* list$/,
  /^pipelines (list|show)$/,
  /^pipelines (runs|build) (list|show)$/,
  /^account show$/,
];

type Tok = string | { op: string; pattern?: string } | { comment: string };

function denyCompound(cwd?: string): Decision {
  return deny('bash: compound', `read-only mode: run one command at a time; you are already in ${cwd ?? 'the working directory'}.`);
}

export function classifyBash(command: string, extraAllow: string[] = [], cwd?: string): Decision {
  let cmd = command.trim();
  cmd = cmd.replace(/\s+2>\s*(\/dev\/null|&1)\s*$/, '');
  if (!cmd) return deny('bash', 'read-only mode: empty command.');
  if (/[\n\r]/.test(cmd)) return denyCompound(cwd);
  if (/\$\(|`|<\(|>\(/.test(cmd)) return deny('bash: substitution', 'read-only mode: command substitution is not allowed. Run one plain command at a time.');

  let toks: Tok[];
  try {
    // Keep $VARS literal instead of expanding them to empty strings.
    toks = shellParse(cmd, (key: string) => `$${key}`) as Tok[];
  } catch {
    return deny('bash: parse', 'read-only mode: could not parse this command.');
  }

  const segments: string[][] = [[]];
  for (const t of toks) {
    if (typeof t === 'string') segments[segments.length - 1].push(t);
    else if ('comment' in t) continue;
    else if (t.op === 'glob') segments[segments.length - 1].push(t.pattern!);
    else if (t.op === '|') segments.push([]);
    else if (t.op === '(' || t.op === ')') return deny('bash: subshell', 'read-only mode: subshells are not allowed. Run one plain command at a time.');
    else if (['>', '>>', '<', '<<', '<<<', '>&', '<&', '>|', '<>', '&>', '&>>'].includes(t.op) || t.op.includes('>') || t.op.includes('<'))
      return deny('bash: redirection', 'read-only mode: redirection is not allowed (writing files is blocked).');
    else return denyCompound(cwd);
  }
  if (segments.some((s) => s.length === 0)) return denyCompound(cwd);

  for (const seg of segments) {
    const d = classifySegment(seg, extraAllow);
    if (!d.allow) return d;
  }
  return allow(segments.length > 1 ? 'bash: pipeline of reads' : 'bash: read command');
}

function classifySegment(argv: string[], extraAllow: string[]): Decision {
  const [cmd, ...args] = argv;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return deny('bash: env prefix', 'read-only mode: VAR=value prefixes are not allowed.');
  const denied = (what: string) => deny('bash allowlist', `read-only mode: \`${what}\` is not on the read-only command list. ${YOLO_HINT}`);

  for (const extra of extraAllow) {
    const words = extra.trim().split(/\s+/);
    if (words.every((w, i) => argv[i] === w)) return allow(`bash extraAllow: ${extra}`);
  }

  if (SHELL_READS.has(cmd)) {
    if (cmd === 'find' && args.some((a) => FIND_DENY.has(a))) return deny('bash: find', 'read-only mode: find with -exec/-delete/-fprint is blocked.');
    if (cmd === 'rg' && args.some((a) => a === '--pre' || a.startsWith('--pre='))) return denied('rg --pre');
    if (cmd === 'tree' && args.some((a) => a === '-o' || a.startsWith('-o'))) return denied('tree -o');
    return allow('bash: shell read');
  }
  if (cmd === 'git') return gitRule(args, denied);
  if (cmd === 'gh') return ghRule(args, denied);
  if (cmd === 'az') return azRule(args, denied);
  return denied(cmd);
}

function gitRule(args: string[], denied: (w: string) => Decision): Decision {
  let i = 0;
  // Allow a few harmless global options: -C <path>, --no-pager.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager') i += 1;
    else return denied(`git ${args[i]}`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return denied('git');
  if (rest.some((a) => a.startsWith('--output'))) return denied(`git ${sub} --output`);
  if (GIT_SIMPLE.has(sub)) return allow(`bash: git ${sub}`);
  if (sub === 'remote' && rest.length === 1 && rest[0] === '-v') return allow('bash: git remote -v');
  if (sub === 'tag' && (rest[0] === '-l' || rest[0] === '--list')) return allow('bash: git tag -l');
  if (sub === 'branch' && rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '-av', '-rv'].includes(a))) return allow('bash: git branch (list)');
  return denied(`git ${sub}${rest.length ? ' ' + rest.join(' ') : ''}`.slice(0, 60));
}

function ghRule(args: string[], denied: (w: string) => Decision): Decision {
  const [group, sub] = args;
  if (group === 'api') return ghApiRule(args.slice(1), denied);
  const allowed = GH_ALLOWED[group];
  if (allowed === '*') return allow(`bash: gh ${group}`);
  if (allowed && sub && allowed.includes(sub)) return allow(`bash: gh ${group} ${sub}`);
  return denied(`gh ${[group, sub].filter(Boolean).join(' ')}`);
}

function ghApiRule(args: string[], denied: (w: string) => Decision): Decision {
  const nonGet = deny('bash: gh api', 'read-only mode: `gh api` is allowed only as a GET request without fields or input.');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'graphql') return deny('bash: gh api graphql', 'read-only mode: `gh api graphql` is blocked (it can run mutations).');
    let method: string | undefined;
    if (a === '-X' || a === '--method') method = args[++i];
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (/^-X./.test(a)) method = a.slice(2);
    if (method !== undefined && method.toUpperCase() !== 'GET') return nonGet;
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) || /^(-[fF].|--(raw-)?field=|--input=)/.test(a)) return nonGet;
  }
  if (!args.some((a) => !a.startsWith('-'))) return denied('gh api');
  return allow('bash: gh api GET');
}

function azRule(args: string[], denied: (w: string) => Decision): Decision {
  const words: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) break;
    words.push(a);
  }
  const phrase = words.join(' ');
  if (phrase === 'rest' || phrase.startsWith('devops invoke')) return deny('bash: az', 'read-only mode: arbitrary REST calls (`az rest`, `az devops invoke`) are blocked.');
  if (AZ_PATTERNS.some((re) => re.test(phrase))) return allow(`bash: az ${phrase}`);
  return denied(`az ${phrase}`);
}
