export interface AppConfig {
  claudeBin: string;
  port: number;
  maxConcurrent: number;
  keepWarm: number;
  defaultModel: string;
  scratchDir: string;
  dirRoots: string[];
  dirScanDepth: number;
  routineCheckMinutes: number;
}

export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  body: string;
  file: string;
  /** Built-in plain Claude Code: no --model and no --append-system-prompt. */
  raw?: boolean;
}

export interface WorkflowStep {
  agent: string;
  prompt: string;
}

export interface WorkflowDef {
  name: string;
  description: string;
  steps: WorkflowStep[];
  file: string;
}

export type Schedule = { daily: string } | { weekly: string };

export interface RoutineDef {
  name: string;
  schedule: Schedule;
  channel: string;
  target: { kind: 'agent' | 'workflow'; id: string };
  dir?: string;
  yolo: boolean;
  prompt: string;
  file: string;
}

export interface ReadonlyConfig {
  servers: Record<string, string>;
  allow: string[];
  deny: string[];
  bash: { extraAllow: string[] };
}

export interface ConfigProblem {
  file: string;
  message: string;
}

export interface LoadedConfig {
  config: AppConfig;
  agents: Record<string, AgentDef>;
  workflows: Record<string, WorkflowDef>;
  routines: Record<string, RoutineDef>;
  readonly: ReadonlyConfig;
  problems: ConfigProblem[];
}
