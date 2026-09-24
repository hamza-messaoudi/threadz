import { useState } from 'react';
import { api, type Conversation } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { DirField } from './DirField.tsx';

export function ChannelSettings({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const { upsertConversation } = useAppData();
  const [name, setName] = useState(conversation.name);
  const [dir, setDir] = useState<string | null>(conversation.dir);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const body: Record<string, unknown> = { name };
      if (conversation.kind === 'channel') body.dir = dir;
      upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, body));
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const archive = async () => {
    if (!confirm(`Archive "${conversation.name}"? It disappears from the sidebar; messages stay searchable.`)) return;
    upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { archived: true }));
    onClose();
    navigate({ view: 'home' });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>{conversation.kind === 'chat' ? 'Chat' : 'Channel'} settings</h3>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {conversation.kind === 'channel' && (
          <label className="field">
            <span>Default directory</span>
            <DirField value={dir} onChange={setDir} />
            <small className="muted">Empty = scratch folder.</small>
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
        <div className="row gap">
          {conversation.kind !== 'routine' && (
            <button type="button" className="btn danger-ghost" onClick={archive}>
              Archive
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </div>
  );
}
