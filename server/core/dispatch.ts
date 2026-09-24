import type { AppContext } from '../app.ts';
import { resolveMentions } from '../context/mentions.ts';
import type { MessageRow, ThreadRow } from '../db/queries.ts';
import { serializeConversation, serializeMessage } from './serialize.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Working directory: #dir mention, else the conversation's dir, else scratchDir. */
export function resolveCwd(ctx: AppContext, conversationDir: string | null, dirMention: string | null): string {
  if (dirMention) return dirMention;
  if (conversationDir) return conversationDir;
  return ctx.scratchDir();
}

/** Agent that answers an untagged message: the last agent in the thread, else the source message's agent. */
export function defaultAgent(ctx: AppContext, thread: ThreadRow): string | null {
  const last = ctx.store.lastAgentInThread(thread.id);
  if (last && ctx.cfg.agents[last]) return last;
  if (thread.parent_message_id) {
    const src = ctx.store.getMessage(thread.parent_message_id);
    if (src?.author_kind === 'agent' && src.author_id && ctx.cfg.agents[src.author_id]) return src.author_id;
  }
  return null;
}

export interface PostResult {
  message: ReturnType<typeof serializeMessage>;
  agentMessageIds: string[];
  workflowRunId?: string;
}

export function postUserMessage(ctx: AppContext, threadId: string, body: { text?: unknown; mentions?: unknown }): PostResult {
  const { store, hub, cfg } = ctx;
  const thread = store.getThread(threadId);
  if (!thread) throw new HttpError(404, 'thread not found');
  const conversation = store.getConversation(thread.conversation_id)!;
  const raw = typeof body.text === 'string' ? body.text : '';
  const text = raw.trim();
  if (!text) throw new HttpError(400, 'empty message');
  // Mention offsets refer to the raw text; keep them valid after trimming.
  const lead = raw.length - raw.trimStart().length;
  if (lead && Array.isArray(body.mentions)) body = { ...body, mentions: body.mentions.map((m: any) => ({ ...m, start: m.start - lead, end: m.end - lead })) };

  const names = { agents: new Set(Object.keys(cfg.agents)), workflows: new Set(Object.keys(cfg.workflows)) };
  const mentions = resolveMentions(text, body.mentions, names);
  if (mentions.workflows.length && mentions.agents.length) throw new HttpError(400, 'a message can tag agents or one workflow, not both');
  if (mentions.workflows.length > 1) throw new HttpError(400, 'tag one workflow at a time');
  let dir: string | null = null;
  if (mentions.dir) {
    if (!ctx.dirs.isKnown(mentions.dir)) throw new HttpError(400, `unknown directory: ${mentions.dir}`);
    dir = mentions.dir;
  }

  // A new chat is named after its first message.
  if (conversation.kind === 'chat' && !thread.parent_thread_id && store.listMessages(thread.id).length === 0) {
    const name = text.replace(/\s+/g, ' ').slice(0, 40).trim() || 'New chat';
    store.updateConversation(conversation.id, { name });
    hub.global('conversation.updated', serializeConversation({ ...store.getConversation(conversation.id)!, root_thread_id: thread.id }));
  }

  const msg = store.insertMessage({
    thread_id: thread.id,
    author_kind: 'user',
    content_md: text,
    status: 'done',
    mentions: Array.isArray(body.mentions) && body.mentions.length ? body.mentions : null,
  });
  hub.thread(thread.id, 'message.created', serializeMessage(msg));
  if (dir) store.touchDir(dir);

  const cwd = resolveCwd(ctx, conversation.dir, dir);
  const trigger = { messageId: msg.id, seq: msg.done_seq!, text, from: 'you' };

  if (mentions.workflows.length) {
    const run = ctx.workflows.start({ workflow: mentions.workflows[0], thread, trigger: msg, cwd, mentions: body.mentions });
    return { message: serializeMessage(msg), agentMessageIds: [], workflowRunId: run.id };
  }

  let agents = mentions.agents;
  if (!agents.length) {
    const d = defaultAgent(ctx, thread);
    agents = d ? [d] : [];
  }
  const agentMessageIds = agents.map((agentName) => ctx.runner.start({ threadId: thread.id, agentName, cwd, trigger }).messageId);
  return { message: serializeMessage(msg), agentMessageIds };
}

export function isDoneMessage(m: MessageRow | undefined): m is MessageRow {
  return !!m && m.status === 'done';
}
