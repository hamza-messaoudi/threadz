import { useEffect, useState } from 'react';
import { api, type Conversation, type RoutineInfo } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { useSseStatus } from '../lib/sse.ts';
import { useAppData } from '../lib/store.tsx';
import { NewChannelDialog } from './NewChannelDialog.tsx';
import { AccChevron, Accordion } from './transitions.tsx';

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  activeId?: string;
  onSearch: () => void;
  newChannelOpen: boolean;
  setNewChannelOpen: (open: boolean) => void;
}

const mac = navigator.platform.includes('Mac');
const shortcut = (key: string) => (mac ? `⌘${key}` : `Ctrl ${key}`);

export function Sidebar({ collapsed, onToggle, activeId, onSearch, newChannelOpen, setNewChannelOpen }: Props) {
  const toggleTitle = `${collapsed ? 'Expand' : 'Collapse'} sidebar (${shortcut('B')})`;
  // Both layers stay mounted and cross-fade (transitions.dev panel reveal) while the column resizes.
  return (
    <div className="sidebar-slot">
      <nav className="sidebar">
        <div className="side-layer side-full t-panel-slide" data-axis="x" data-open={!collapsed} inert={collapsed}>
          <FullSidebar activeId={activeId} onSearch={onSearch} onNewChannel={() => setNewChannelOpen(true)} />
        </div>
        <div className="side-layer side-rail t-panel-slide" data-axis="x" data-open={collapsed} inert={!collapsed}>
          <Rail onSearch={onSearch} onNewChannel={() => setNewChannelOpen(true)} />
        </div>
      </nav>
      {/* One toggle for both states: it rides the column's edge and swaps its icon (transitions.dev icon swap). */}
      <button className="rail-btn side-toggle-btn" onClick={onToggle} data-tooltip={toggleTitle} data-tooltip-side={collapsed ? 'right' : undefined} aria-label={toggleTitle} aria-expanded={!collapsed}>
        <span className="t-icon-swap" data-state={collapsed ? 'b' : 'a'}>
          <span className="t-icon" data-icon="a">
            <Icon d={PANEL_CLOSE} />
          </span>
          <span className="t-icon" data-icon="b">
            <Icon d={PANEL_OPEN} />
          </span>
        </span>
      </button>
      {newChannelOpen && <NewChannelDialog onClose={() => setNewChannelOpen(false)} />}
    </div>
  );
}

function Rail(props: { onSearch: () => void; onNewChannel: () => void }) {
  const status = useSseStatus();
  return (
    <div className="rail">
      <button className="rail-btn" onClick={props.onSearch} data-tooltip={`Search (${shortcut('K')})`} data-tooltip-side="right" aria-label="Search">
        <Icon d={SEARCH} />
      </button>
      <button className="rail-btn" onClick={() => navigate({ view: 'conversation', conversationId: 'new' })} data-tooltip="New chat" data-tooltip-side="right" aria-label="New chat">
        <Icon d={CHAT} />
      </button>
      <button className="rail-btn" onClick={props.onNewChannel} data-tooltip="New channel" data-tooltip-side="right" aria-label="New channel">
        <Icon d={HASH} />
      </button>
      <span className="spacer" />
      <span className={`conn conn-${status}`} data-tooltip={`Live updates: ${status}`} data-tooltip-side="right" />
      <button className="rail-btn" onClick={() => navigate({ view: 'settings' })} data-tooltip="Settings" data-tooltip-side="right" aria-label="Settings">
        <Icon d={GEAR} />
      </button>
    </div>
  );
}

function FullSidebar(props: { activeId?: string; onSearch: () => void; onNewChannel: () => void }) {
  const { activeId } = props;
  const { conversations, routines } = useAppData();
  const channels = conversations.filter((c) => c.kind === 'channel').sort((a, b) => a.name.localeCompare(b.name));
  const chats = conversations.filter((c) => c.kind === 'chat').sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const status = useSseStatus();

  return (
    <>
      <div className="sidebar-head">
        <span className="brand">Agent Chat</span>
        <span className={`conn conn-${status}`} data-tooltip={`Live updates: ${status}`} />
      </div>
      <button className="search-trigger" onClick={props.onSearch}>
        <span>Search</span>
        <kbd>{shortcut('K')}</kbd>
      </button>

      <Section title="Channels" onAdd={props.onNewChannel} addLabel="New channel">
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
    </>
  );
}

// 24×24 stroke paths (Lucide-style).
const PANEL = 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18';
const PANEL_CLOSE = `${PANEL}M16 15l-3-3 3-3`;
const PANEL_OPEN = `${PANEL}M14 9l3 3-3 3`;
const SEARCH = 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3';
const CHAT = 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12zM12 9v6M9 12h6';
const ARCHIVE = 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4';
const PLUS = 'M12 5v14M5 12h14';
const HASH = 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18';
const GEAR =
  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z';

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Section(props: { title: string; onAdd?: () => void; addLabel?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <Accordion
      open={open}
      className="side-section"
      head={
        <div className="side-title">
          <button className="side-toggle t-acc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            {props.title} <AccChevron />
          </button>
          {props.onAdd && (
            <button className="side-add" onClick={props.onAdd} data-tooltip={props.addLabel} aria-label={props.addLabel}>
              <Icon d={PLUS} />
            </button>
          )}
        </div>
      }
    >
      <div className="side-items">{props.children}</div>
    </Accordion>
  );
}

function Item({ c, active, prefix }: { c: Conversation; active: boolean; prefix: string }) {
  const { upsertConversation } = useAppData();
  // Archive asks once: the first click arms the icon for a few seconds, the second one archives.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const archive = async () => {
    if (!armed) return setArmed(true);
    upsertConversation(await api.patch<Conversation>(`/api/conversations/${c.id}`, { archived: true }));
    if (active) navigate({ view: 'home' });
  };
  return (
    <div className={`side-item-row ${armed ? 'armed' : ''}`} onMouseLeave={() => setArmed(false)}>
      <button className={`side-item ${active ? 'active' : ''}`} onClick={() => navigate({ view: 'conversation', conversationId: c.id })}>
        {prefix && <span className="hash">{prefix}</span>}
        <span className="side-name">{c.name}</span>
        {c.yolo && <span className="yolo-dot" data-tooltip="YOLO on" />}
      </button>
      <button
        className="side-archive"
        onClick={archive}
        data-tooltip={armed ? 'Click again to archive. Messages stay searchable.' : 'Archive'}
        aria-label={armed ? `Confirm archive ${c.name}` : `Archive ${c.name}`}
      >
        <Icon d={ARCHIVE} />
      </button>
    </div>
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
