export type ConversationKind = 'channel' | 'chat' | 'routine';

export interface Conversation {
  id: string;
  kind: ConversationKind;
  name: string;
  dir: string | null;
  yolo: boolean;
  routineId: string | null;
  archived: boolean;
  createdAt: number;
  rootThreadId: string;
  lastActivity?: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  input: unknown;
  output_preview?: string;
  denied?: boolean;
  is_error?: boolean;
  /** Length of the message text when the call began; absent on older messages. */
  at?: number;
  /** Orders steps that began at the same `at`. */
  seq?: number;
}

/** A thinking summary, placed like a tool call. */
export interface ThinkingEvent {
  id: string;
  text: string;
  at: number;
  seq?: number;
}

export interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  first_call?: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  total_cost_usd?: number;
  /** The document reader turn that ran before this one (a long document's first thread). */
  reader?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; total_cost_usd?: number };
}

export interface Mention {
  /** `dir` references a directory for one message; `cd` moves the thread into it. */
  kind: 'agent' | 'workflow' | 'dir' | 'cd';
  id: string;
  start: number;
  end: number;
}

export interface Message {
  id: string;
  threadId: string;
  authorKind: 'user' | 'agent' | 'system';
  authorId: string | null;
  content: string;
  toolEvents: ToolEvent[];
  thinking?: ThinkingEvent[];
  status: 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';
  error: string | null;
  usage: Usage | null;
  runId: string | null;
  doneSeq: number | null;
  createdAt: number;
  cwd: string | null;
  sessionId: string | null;
  markers: string[];
  mentions: Mention[] | null;
  meta: any;
  run?: Run | null;
}

export interface Run {
  id: string;
  kind: string;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  meta: any;
}

export interface ThreadInfo {
  id: string;
  conversationId: string;
  parentThreadId: string | null;
  parentMessageId: string | null;
  blockIndex: number | null;
  /** Last quoted block (inclusive); equals blockIndex for a one-paragraph thread. */
  blockEnd: number | null;
  blockText: string | null;
  /** Where the thread's turns run now. */
  cwd: string;
  /** True after a move away from the default directory. */
  moved: boolean;
}

export interface ChildThread {
  id: string;
  parentMessageId: string;
  blockIndex: number;
  blockEnd: number;
  replyCount: number;
  lastActivity: number;
  /** Set once the thread became its own channel. */
  channel: { id: string; name: string } | null;
}

/** Where a channel made from a side thread came from. */
export interface ThreadOrigin {
  threadId: string;
  conversationId: string;
  conversationName: string;
  conversationKind: ConversationKind;
}

export interface ThreadData {
  thread: ThreadInfo;
  messages: Message[];
  childThreads: ChildThread[];
  runs?: Record<string, Run>;
  sourceMessage?: Message | null;
  origin?: ThreadOrigin | null;
}

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  /** The built-in neutral agent (plain Claude Code). */
  builtin?: boolean;
  /** `graphs`: the agent is taught Comark figures. */
  render?: 'graphs';
}

export interface RoutineInfo {
  name: string;
  schedule: { daily?: string; weekly?: string };
  channel: string;
  target: string;
  dir?: string;
  yolo: boolean;
  status?: 'ok' | 'running' | 'error' | 'pending';
  nextSlot?: number;
  lastError?: string | null;
  conversationId?: string | null;
}

export interface ConfigInfo {
  agents: AgentInfo[];
  workflows: { name: string; description: string; steps: string[] }[];
  routines: RoutineInfo[];
  problems: { file: string; message: string }[];
  claudeBin: string;
  scratchDir: string;
  dirRoots: string[];
  homeDir: string;
  defaultModel: string;
}

export interface DirResult {
  path: string;
  name: string;
  root: string | null;
  branch: string | null;
  recent: boolean;
}

export interface SearchResult {
  messageId: string;
  threadId: string;
  conversationId: string;
  conversationName: string;
  conversationKind: ConversationKind;
  inThread: boolean;
  authorKind: string;
  authorId: string | null;
  createdAt: number;
  snippet: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      // not json
    }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T>(url: string) => req<T>('DELETE', url),
};
