import { useCallback, useEffect, useReducer } from 'react';
import { api, type ChildThread, type Message, type Run, type ThreadData } from './api.ts';
import { useSse } from './sse.ts';

export interface ThreadState {
  loading: boolean;
  /** This thread was deleted (null) or merged into another thread (its id). */
  gone?: { into: string | null };
  error: string | null;
  data: (ThreadData & { defaultAgent: string | null }) | null;
  messages: Message[];
  childThreads: ChildThread[];
  runs: Record<string, Run>;
}

type Action =
  | { type: 'loaded'; data: ThreadState['data'] }
  | { type: 'error'; error: string }
  | { type: 'upsert'; message: Message }
  | { type: 'delta'; id: string; text: string }
  | { type: 'tool'; id: string; toolEvents: Message['toolEvents'] }
  | { type: 'thinking'; id: string; thinkingId: string; at: number; seq: number; text: string }
  | { type: 'thread'; child: ChildThread }
  | { type: 'unthread'; id: string }
  | { type: 'gone'; into: string | null }
  | { type: 'run'; run: Run }
  | { type: 'moved'; cwd: string; moved: boolean }
  | { type: 'promoted'; conversationId: string };

const initial: ThreadState = { loading: true, error: null, data: null, messages: [], childThreads: [], runs: {} };

function reducer(s: ThreadState, a: Action): ThreadState {
  switch (a.type) {
    case 'loaded':
      return {
        loading: false,
        error: null,
        data: a.data,
        messages: a.data!.messages,
        childThreads: a.data!.childThreads,
        runs: a.data!.runs ?? {},
      };
    case 'error':
      return { ...s, loading: false, error: a.error };
    case 'upsert': {
      const i = s.messages.findIndex((m) => m.id === a.message.id);
      if (i < 0) return { ...s, messages: [...s.messages, a.message].sort((x, y) => (x.id < y.id ? -1 : 1)) };
      const messages = s.messages.slice();
      messages[i] = a.message;
      return { ...s, messages };
    }
    case 'delta': {
      const i = s.messages.findIndex((m) => m.id === a.id);
      if (i < 0) return s;
      const messages = s.messages.slice();
      messages[i] = { ...messages[i], content: messages[i].content + a.text, status: 'streaming' };
      return { ...s, messages };
    }
    case 'tool': {
      const i = s.messages.findIndex((m) => m.id === a.id);
      if (i < 0) return s;
      const messages = s.messages.slice();
      messages[i] = { ...messages[i], toolEvents: a.toolEvents };
      return { ...s, messages };
    }
    case 'thinking': {
      const i = s.messages.findIndex((m) => m.id === a.id);
      if (i < 0) return s;
      const messages = s.messages.slice();
      const list = messages[i].thinking ?? [];
      const t = list.find((x) => x.id === a.thinkingId);
      const thinking = t ? list.map((x) => (x === t ? { ...x, text: x.text + a.text } : x)) : [...list, { id: a.thinkingId, at: a.at, seq: a.seq, text: a.text }];
      messages[i] = { ...messages[i], thinking };
      return { ...s, messages };
    }
    case 'thread': {
      const rest = s.childThreads.filter((t) => t.id !== a.child.id);
      return { ...s, childThreads: [...rest, a.child] };
    }
    case 'unthread':
      return { ...s, childThreads: s.childThreads.filter((t) => t.id !== a.id) };
    case 'gone':
      return { ...s, gone: { into: a.into } };
    case 'run':
      return { ...s, runs: { ...s.runs, [a.run.id]: a.run } };
    case 'moved':
      return s.data ? { ...s, data: { ...s.data, thread: { ...s.data.thread, cwd: a.cwd, moved: a.moved } } } : s;
    case 'promoted':
      return s.data ? { ...s, data: { ...s.data, thread: { ...s.data.thread, conversationId: a.conversationId, parentThreadId: null } } } : s;
  }
}

/** Loads a thread over REST and keeps it live over SSE; refetches after every reconnect. */
export function useThread(threadId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial);

  const load = useCallback(async () => {
    if (!threadId) return;
    try {
      dispatch({ type: 'loaded', data: await api.get(`/api/threads/${threadId}`) });
    } catch (e: any) {
      dispatch({ type: 'error', error: e.message });
    }
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  useSse(
    threadId ? `/api/threads/${threadId}/events` : null,
    (event, d) => {
      if (event === 'message.created' || event === 'message.updated' || event === 'message.done') dispatch({ type: 'upsert', message: d });
      else if (event === 'message.delta') dispatch({ type: 'delta', id: d.id, text: d.text });
      else if (event === 'message.tool') dispatch({ type: 'tool', id: d.id, toolEvents: d.toolEvents });
      else if (event === 'message.thinking') dispatch({ type: 'thinking', id: d.id, thinkingId: d.thinkingId, at: d.at, seq: d.seq, text: d.text });
      else if (event === 'thread.created') dispatch({ type: 'thread', child: d });
      else if (event === 'thread.removed') dispatch({ type: 'unthread', id: d.id });
      else if (event === 'thread.merged' && d.id === threadId) dispatch({ type: 'gone', into: d.into });
      else if (event === 'thread.deleted' && d.id === threadId) dispatch({ type: 'gone', into: null });
      // The passage grew, or the replies were cleared: reload the thread as it is now.
      else if ((event === 'thread.passage' || event === 'thread.reset') && d.id === threadId) load();
      else if (event === 'run.updated') dispatch({ type: 'run', run: d });
      else if (event === 'thread.updated' && d.id === threadId) dispatch({ type: 'moved', cwd: d.cwd, moved: d.moved });
      else if (event === 'thread.promoted' && d.id === threadId) dispatch({ type: 'promoted', conversationId: d.conversationId });
    },
    load,
  );

  // The agent an untagged message goes to: the last one that replied here, else the server's default.
  const lastAgent = [...state.messages].reverse().find((m) => m.authorKind === 'agent' && m.status !== 'cancelled')?.authorId;
  return { ...state, defaultAgent: lastAgent ?? state.data?.defaultAgent ?? null, reload: load };
}
