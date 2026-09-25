import { useEffect, useRef, useState } from 'react';

export type SseStatus = 'connecting' | 'open' | 'closed';

type Handler = (event: string, data: any) => void;

const listeners = new Set<(s: SseStatus) => void>();
let globalStatus: SseStatus = 'connecting';
function setGlobalStatus(s: SseStatus) {
  globalStatus = s;
  for (const l of listeners) l(s);
}

/**
 * Subscribes to an SSE endpoint with automatic reconnect. `onOpen` runs on every (re)connect so the
 * caller can refetch over REST; there is no replay log on the server.
 */
export function useSse(url: string | null, onEvent: Handler, onOpen?: () => void, trackStatus = false) {
  const handler = useRef(onEvent);
  const opener = useRef(onOpen);
  handler.current = onEvent;
  opener.current = onOpen;

  useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let stopped = false;

    const connect = () => {
      es = new EventSource(url);
      if (trackStatus) setGlobalStatus('connecting');
      es.addEventListener('ready', () => {
        delay = 500;
        if (trackStatus) setGlobalStatus('open');
        // Refetch on every (re)connect: events sent before the subscription existed are not replayed.
        opener.current?.();
      });
      es.onmessage = () => {};
      for (const ev of EVENTS) {
        es.addEventListener(ev, (e) => {
          try {
            handler.current(ev, JSON.parse((e as MessageEvent).data));
          } catch {
            // ignore malformed event
          }
        });
      }
      es.onerror = () => {
        es?.close();
        if (stopped) return;
        if (trackStatus) setGlobalStatus('closed');
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10000);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [url, trackStatus]);
}

const EVENTS = [
  'message.created',
  'message.delta',
  'message.tool',
  'message.thinking',
  'message.updated',
  'message.done',
  'thread.created',
  'thread.updated',
  'thread.promoted',
  'thread.removed',
  'thread.merged',
  'thread.deleted',
  'thread.passage',
  'thread.reset',
  'run.updated',
  'conversation.updated',
  'config.changed',
  'routine.status',
  'dirs.changed',
];

export function useSseStatus(): SseStatus {
  const [s, setS] = useState(globalStatus);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
