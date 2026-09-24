import { useState } from 'react';
import { api, type Conversation, type RoutineInfo } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { useSseStatus } from '../lib/sse.ts';
import { useAppData } from '../lib/store.tsx';
import { NewChannelDialog } from './NewChannelDialog.tsx';

interface Props {
  activeId?: string;
  onSearch: () => void;
  newChannelOpen: boolean;
  setNewChannelOpen: (open: boolean) => void;
}

export function Sidebar({ activeId, onSearch, newChannelOpen, setNewChannelOpen }: Props) {
  const { conversations, routines } = useAppData();
  const channels = conversations.filter((c) => c.kind === 'channel').sort((a, b) => a.name.localeCompare(b.name));
  const chats = conversations.filter((c) => c.kind === 'chat').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const status = useSseStatus();

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Agent Chat</span>
        <span className={`conn conn-${status}`} title={`live updates: ${status}`} />
      </div>
      <button className="search-trigger" onClick={onSearch}>
        <span>Search</span>
        <kbd>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <Section title="Channels" onAdd={() => setNewChannelOpen(true)} addLabel="New channel">
        {channels.map((c) => (
          <Item key={c.id} c={c} active={c.id === activeId} prefix="#" />
        ))}
        {!channels.length && <div className="side-empty">No channels yet</div>}
      </Section>

      <Section title="Chats" onAdd={() => navigate({ view: 'conversation', conversationId: 'new' })} addLabel="New chat">
        {chats.map((c) => (
          <Item key={c.id} c={c} active={c.id === activeId} prefix="" />
        ))}
        {!chats.length && <div className="side-empty">No chats yet</div>}
      </Section>

      <Section title="Routines">
        {routines.map((r) => (
          <RoutineItem key={r.name} r={r} active={!!r.conversationId && r.conversationId === activeId} />
        ))}
        {!routines.length && <div className="side-empty">No routines configured</div>}
      </Section>

      <div className="sidebar-foot">
        <button className="link" onClick={() => navigate({ view: 'settings' })}>
          Settings
        </button>
      </div>
      {newChannelOpen && <NewChannelDialog onClose={() => setNewChannelOpen(false)} />}
    </nav>
  );
}

function Section(props: { title: string; onAdd?: () => void; addLabel?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="side-section">
      <div className="side-title">
        <button className="side-toggle" onClick={() => setOpen(!open)}>
          <span className={`caret ${open ? 'open' : ''}`}>▸</span> {props.title}
        </button>
        {props.onAdd && (
          <button className="side-add" onClick={props.onAdd} title={props.addLabel} aria-label={props.addLabel}>
            +
          </button>
        )}
      </div>
      {open && <div className="side-items">{props.children}</div>}
    </div>
  );
}

function Item({ c, active, prefix }: { c: Conversation; active: boolean; prefix: string }) {
  return (
    <button className={`side-item ${active ? 'active' : ''}`} onClick={() => navigate({ view: 'conversation', conversationId: c.id })}>
      {prefix && <span className="hash">{prefix}</span>}
      <span className="side-name">{c.name}</span>
      {c.yolo && <span className="yolo-dot" title="YOLO on" />}
    </button>
  );
}

function RoutineItem({ r, active }: { r: RoutineInfo; active: boolean }) {
  const open = async () => {
    if (r.conversationId) navigate({ view: 'conversation', conversationId: r.conversationId });
    else {
      const res = await api.post<{ conversationId: string }>(`/api/routines/${encodeURIComponent(r.name)}/channel`);
      navigate({ view: 'conversation', conversationId: res.conversationId });
    }
  };
  const next = r.nextSlot ? new Date(r.nextSlot) : null;
  return (
    <button className={`side-item ${active ? 'active' : ''}`} onClick={open} title={r.lastError ?? undefined}>
      <span className={`status-dot st-${r.status ?? 'pending'}`} />
      <span className="side-name">{r.name}</span>
      {next && (
        <span className="side-meta">
          {next.toLocaleDateString(undefined, { weekday: 'short' })} {next.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </button>
  );
}
