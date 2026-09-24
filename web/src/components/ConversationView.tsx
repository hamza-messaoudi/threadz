import { useState } from 'react';
import type { Conversation } from '../lib/api.ts';
import type { Route } from '../lib/router.ts';
import { ChannelSettings } from './ChannelSettings.tsx';

interface Props {
  conversationId: string;
  conversation?: Conversation;
  route: Route;
}

export function ConversationView({ conversation }: Props) {
  const [settings, setSettings] = useState(false);
  if (!conversation) return <div className="empty-state muted">Loading…</div>;
  return (
    <div className="conversation">
      <div className="conv-main">
        <header className="conv-head">
          <h2>
            {conversation.kind === 'channel' && <span className="hash">#</span>}
            {conversation.name}
          </h2>
          {conversation.dir && <span className="conv-dir" title={conversation.dir}>{conversation.dir}</span>}
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setSettings(true)}>
            Settings
          </button>
        </header>
        <div className="messages-scroll">
          <div className="empty-state muted">No messages yet.</div>
        </div>
      </div>
      <aside className="panel-slot" />
      {settings && <ChannelSettings conversation={conversation} onClose={() => setSettings(false)} />}
    </div>
  );
}
