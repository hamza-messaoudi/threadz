import { useEffect, useState } from 'react';
import type { ChildThread, Message, Run } from '../lib/api.ts';
import { docMeta } from '../lib/document.ts';
import { DocumentMessage } from './DocumentMessage.tsx';
import { MessageView, type BlockRange } from './Message.tsx';

/** A run of blocks in one message. */
export interface Passage extends BlockRange {
  messageId: string;
}

interface Props {
  messages: Message[];
  childThreads?: ChildThread[];
  runs?: Record<string, Run>;
  onOpenThread?: (m: Message, start: number, end?: number) => void;
  onExtendPassage?: (m: Message, blockIndex: number, at: DOMRect) => void;
  allowThreads?: boolean;
  activeSource?: Passage | null;
  pending?: Passage | null;
  focusId?: string;
}

export function MessageList({ messages, childThreads, runs, onOpenThread, onExtendPassage, allowThreads, activeSource, pending, focusId }: Props) {
  const [flashId, setFlashId] = useState<string | null>(null);

  // Scroll to and flash a message (search results, deep links).
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`m-${focusId}`);
    if (!el) return;
    // A document is taller than the screen: show its start, not its middle.
    el.scrollIntoView({ block: docMeta(messages.find((m) => m.id === focusId)) ? 'start' : 'center' });
    setFlashId(focusId);
    const t = setTimeout(() => setFlashId(null), 1700);
    return () => clearTimeout(t);
  }, [focusId, messages.length > 0]);

  return (
    <div className="message-list">
      {messages.map((m) => {
        const View = docMeta(m) ? DocumentMessage : MessageView;
        return (
          <View
            key={m.id}
            m={m}
            childThreads={childThreads}
            run={m.runId ? runs?.[m.runId] : undefined}
            onOpenThread={onOpenThread}
            onExtendPassage={onExtendPassage}
            allowThreads={allowThreads}
            activeRange={activeSource?.messageId === m.id ? activeSource : null}
            pendingRange={pending?.messageId === m.id ? pending : null}
            flash={flashId === m.id}
          />
        );
      })}
    </div>
  );
}
