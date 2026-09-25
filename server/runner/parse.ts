export interface UsageInfo {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens?: number;
}

export type RunnerEvent =
  | { type: 'init'; sessionId: string; tools: string[]; model?: string; cwd?: string }
  | { type: 'textDelta'; text: string }
  /** `block` names the thinking block, so its deltas join up. */
  | { type: 'thinkingDelta'; block: string; text: string }
  | { type: 'toolUse'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; id: string; preview: string; isError: boolean; denied: boolean }
  | { type: 'firstUsage'; usage: UsageInfo }
  | {
      type: 'result';
      sessionId?: string;
      isError: boolean;
      subtype?: string;
      text?: string;
      usage?: Record<string, unknown>;
      costUsd?: number;
      errors?: string[];
    };

const PREVIEW_BYTES = 2048;

function preview(content: unknown): string {
  let s: string;
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content))
    s = content.map((c: any) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : JSON.stringify(c))).join('\n');
  else s = content === undefined ? '' : JSON.stringify(content);
  return s.length > PREVIEW_BYTES ? s.slice(0, PREVIEW_BYTES) + '…' : s;
}

/** A denied tool call comes back as an error result written by our PreToolUse hook (Phase 0, Q7). */
export function isDeniedResult(text: string): boolean {
  return /^PreToolUse:[^\n]*hook error/.test(text);
}

/**
 * Line-buffered parser for `claude -p --output-format stream-json --verbose [--include-partial-messages]`.
 * Only top-level (non-subagent) text, thinking and tool calls are surfaced.
 */
export class StreamParser {
  private buf = '';
  private streamedMessages = new Set<string>();
  private streamedThinking = new Set<string>();
  private wholeThinking = 0;
  private currentMessageId: string | null = null;
  private emittedText = false;
  private textStartedFor = new Set<string>();
  private gotFirstUsage = false;
  unknownTypes = new Set<string>();

  constructor(private readonly emit: (e: RunnerEvent) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  end(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.line(rest);
  }

  private line(line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // non-JSON noise from a wrapper
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.emit({ type: 'init', sessionId: ev.session_id, tools: ev.tools ?? [], model: ev.model, cwd: ev.cwd });
        }
        return;
      case 'stream_event':
        return this.streamEvent(ev);
      case 'assistant':
        return this.assistant(ev);
      case 'user':
        return this.user(ev);
      case 'result':
        this.emit({
          type: 'result',
          sessionId: ev.session_id,
          isError: !!ev.is_error,
          subtype: ev.subtype,
          text: typeof ev.result === 'string' ? ev.result : undefined,
          usage: ev.usage,
          costUsd: ev.total_cost_usd,
          errors: Array.isArray(ev.errors) ? ev.errors.map(String) : undefined,
        });
        return;
      case 'rate_limit_event':
        return;
      default:
        this.unknownTypes.add(String(ev.type));
    }
  }

  private noteUsage(usage: any): void {
    if (this.gotFirstUsage || !usage) return;
    this.gotFirstUsage = true;
    this.emit({
      type: 'firstUsage',
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }

  private text(messageId: string, text: string): void {
    if (!text) return;
    // Separate the text of consecutive assistant messages (e.g. before and after a tool call).
    if (!this.textStartedFor.has(messageId)) {
      this.textStartedFor.add(messageId);
      if (this.emittedText) text = '\n\n' + text;
    }
    this.emittedText = true;
    this.emit({ type: 'textDelta', text });
  }

  private streamEvent(ev: any): void {
    if (ev.parent_tool_use_id) return;
    const e = ev.event;
    if (!e) return;
    if (e.type === 'message_start') {
      this.currentMessageId = e.message?.id ?? null;
      this.noteUsage(e.message?.usage);
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.currentMessageId) {
      this.streamedMessages.add(this.currentMessageId);
      this.text(this.currentMessageId, e.delta.text);
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && this.currentMessageId && e.delta.thinking) {
      this.streamedThinking.add(this.currentMessageId);
      this.emit({ type: 'thinkingDelta', block: `${this.currentMessageId}:${e.index ?? 0}`, text: e.delta.thinking });
    }
  }

  private assistant(ev: any): void {
    if (ev.parent_tool_use_id) return;
    const msg = ev.message;
    if (!msg) return;
    this.noteUsage(msg.usage);
    for (const block of msg.content ?? []) {
      if (block.type === 'text' && !this.streamedMessages.has(msg.id)) this.text(msg.id, block.text);
      else if (block.type === 'thinking' && block.thinking && !this.streamedThinking.has(msg.id))
        this.emit({ type: 'thinkingDelta', block: `${msg.id}:whole${this.wholeThinking++}`, text: block.thinking });
      else if (block.type === 'tool_use') this.emit({ type: 'toolUse', id: block.id, name: block.name, input: block.input });
    }
  }

  private user(ev: any): void {
    if (ev.parent_tool_use_id) return;
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const p = preview(block.content);
      const isError = !!block.is_error;
      this.emit({ type: 'toolResult', id: block.tool_use_id, preview: p, isError, denied: isError && isDeniedResult(p) });
    }
  }
}
