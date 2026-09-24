import { useEffect, useState } from 'react';
import type { ChildThread, Message, Run } from '../lib/api.ts';
import { MessageView } from './Message.tsx';

interface Props {
  messages: Message[];
  childThreads?: ChildThread[];
  runs?: Record<string, Run>;
  onOpenThread?: (m: Message, blockIndex: number) => void;
  allowThreads?: boolean;
  activeSource?: { messageId: string; blockIndex: number } | null;
  focusId?: string;
}

export function MessageList({ messages, childThreads, runs, onOpenThread, allowThreads, activeSource, focusId }: Props) {
  const [flashId, setFlashId] = useState<string | null>(null);

  // Scroll to and flash a message (search results, deep links).
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`m-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setFlashId(focusId);
    const t = setTimeout(() => setFlashId(null), 1700);
    return () => clearTimeout(t);
  }, [focusId, messages.length > 0]);

  return (
    <div className="message-list">
      {messages.map((m) => (
        <MessageView
          key={m.id}
          m={m}
          childThreads={childThreads}
          run={m.runId ? runs?.[m.runId] : undefined}
          onOpenThread={onOpenThread}
          allowThreads={allowThreads}
          activeBlock={activeSource?.messageId === m.id ? activeSource.blockIndex : null}
          flash={flashId === m.id}
        />
      ))}
    </div>
  );
}
