import { expandHome } from '../paths.ts';
import type { AgentDef, AppConfig, ReadonlyConfig, RoutineDef, Schedule, WorkflowDef } from './types.ts';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class ConfigError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new ConfigError(`missing "${field}"`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ConfigError(`"${field}" must be a string`);
  return v;
}

function strList(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ConfigError(`"${field}" must be a list of strings`);
  return v as string[];
}

function int(v: unknown, field: string, def: number, min: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ConfigError(`"${field}" must be an integer >= ${min}`);
  return v;
}

export const DEFAULT_CONFIG: AppConfig = {
  claudeBin: 'claude',
  port: 4777,
  maxConcurrent: 4,
  keepWarm: 0,
  defaultModel: 'sonnet',
  scratchDir: expandHome('~/.local/share/agent-chat/scratch'),
  dirRoots: [],
  dirScanDepth: 2,
  routineCheckMinutes: 10,
};

export function validateAppConfig(raw: unknown): AppConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
  if (!isObj(raw)) throw new ConfigError('config.yaml must be a mapping');
  const d = DEFAULT_CONFIG;
  return {
    claudeBin: expandHome(str(raw.claudeBin, 'claudeBin', false) ?? d.claudeBin),
    port: int(raw.port, 'port', d.port, 1),
    maxConcurrent: int(raw.maxConcurrent, 'maxConcurrent', d.maxConcurrent, 1),
    keepWarm: int(raw.keepWarm, 'keepWarm', d.keepWarm, 0),
    defaultModel: str(raw.defaultModel, 'defaultModel', false) ?? d.defaultModel,
    scratchDir: expandHome(str(raw.scratchDir, 'scratchDir', false) ?? d.scratchDir),
    dirRoots: (strList(raw.dirRoots, 'dirRoots') ?? d.dirRoots).map(expandHome),
    dirScanDepth: int(raw.dirScanDepth, 'dirScanDepth', d.dirScanDepth, 0),
    routineCheckMinutes: int(raw.routineCheckMinutes, 'routineCheckMinutes', d.routineCheckMinutes, 1),
  };
}

export function validateAgent(data: unknown, body: string, file: string, fallbackName: string): AgentDef {
  const fm = isObj(data) ? data : {};
  const name = str(fm.name, 'name', false) ?? fallbackName;
  if (!NAME_RE.test(name)) throw new ConfigError(`invalid agent name "${name}"`);
  const render = str(fm.render, 'render', false);
  if (render !== undefined && render !== 'graphs') throw new ConfigError(`"render" must be "graphs" (got "${render}")`);
  let tools = fm.tools;
  if (typeof tools === 'string') tools = tools.split(',').map((t) => t.trim()).filter(Boolean);
  return {
    name,
    description: str(fm.description, 'description', false) ?? '',
    model: str(fm.model, 'model', false),
    tools: strList(tools, 'tools'),
    ...(render ? { render } : {}),
    body: body.trim(),
    file,
  };
}

export function validateWorkflow(raw: unknown, file: string, fallbackName: string): WorkflowDef {
  if (!isObj(raw)) throw new ConfigError('workflow must be a mapping');
  const name = str(raw.name, 'name', false) ?? fallbackName;
  if (!NAME_RE.test(name)) throw new ConfigError(`invalid workflow name "${name}"`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new ConfigError('"steps" must be a non-empty list');
  const steps = raw.steps.map((s, i) => {
    if (!isObj(s)) throw new ConfigError(`step ${i + 1} must be a mapping`);
    return { agent: str(s.agent, `steps[${i}].agent`)!, prompt: str(s.prompt, `steps[${i}].prompt`)! };
  });
  return { name, description: str(raw.description, 'description', false) ?? '', steps, file };
}

export function validateSchedule(raw: unknown): Schedule {
  if (!isObj(raw)) throw new ConfigError('"schedule" must be { daily: "HH:MM" } or { weekly: "ddd HH:MM" }');
  if (typeof raw.daily === 'string') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.daily)) throw new ConfigError(`invalid daily time "${raw.daily}"`);
    return { daily: raw.daily };
  }
  if (typeof raw.weekly === 'string') {
    const m = /^([a-z]{3}) ([01]\d|2[0-3]):[0-5]\d$/i.exec(raw.weekly);
    if (!m || !DAYS.includes(m[1].toLowerCase())) throw new ConfigError(`invalid weekly schedule "${raw.weekly}"`);
    return { weekly: raw.weekly.toLowerCase() };
  }
  throw new ConfigError('"schedule" must have "daily" or "weekly"');
}

export function validateRoutine(raw: unknown, file: string, fallbackName: string): RoutineDef {
  if (!isObj(raw)) throw new ConfigError('routine must be a mapping');
  const name = str(raw.name, 'name', false) ?? fallbackName;
  if (!NAME_RE.test(name)) throw new ConfigError(`invalid routine name "${name}"`);
  const target = str(raw.target, 'target')!;
  const m = /^(agent|workflow):(.+)$/.exec(target);
  if (!m) throw new ConfigError('"target" must be agent:<name> or workflow:<name>');
  const dir = str(raw.dir, 'dir', false);
  return {
    name,
    schedule: validateSchedule(raw.schedule),
    channel: str(raw.channel, 'channel', false) ?? `routine-${name}`,
    target: { kind: m[1] as 'agent' | 'workflow', id: m[2] },
    dir: dir ? expandHome(dir) : undefined,
    yolo: raw.yolo === true,
    prompt: str(raw.prompt, 'prompt')!,
    file,
  };
}

export function validateReadonly(raw: unknown): ReadonlyConfig {
  const out: ReadonlyConfig = { servers: {}, allow: [], deny: [], bash: { extraAllow: [] } };
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) throw new ConfigError('readonly.yaml must be a mapping');
  if (raw.servers !== undefined) {
    if (!isObj(raw.servers)) throw new ConfigError('"servers" must be a mapping of server name to profile');
    for (const [k, v] of Object.entries(raw.servers)) {
      if (v !== 'github' && v !== 'azure-devops' && v !== 'none') throw new ConfigError(`unknown profile "${String(v)}" for server "${k}"`);
      out.servers[k] = v;
    }
  }
  out.allow = strList(raw.allow, 'allow') ?? [];
  out.deny = strList(raw.deny, 'deny') ?? [];
  if (raw.bash !== undefined) {
    if (!isObj(raw.bash)) throw new ConfigError('"bash" must be a mapping');
    out.bash.extraAllow = strList(raw.bash.extraAllow, 'bash.extraAllow') ?? [];
  }
  return out;
}
