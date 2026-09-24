import { useState } from 'react';
import { api, type Conversation } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { DirField } from './DirField.tsx';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const { upsertConversation } = useAppData();
  const [name, setName] = useState('');
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<Conversation>('/api/conversations', { kind: 'channel', name, dir });
      upsertConversation(c);
      onClose();
      navigate({ view: 'conversation', conversationId: c.id });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New channel</h3>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. main-repo" />
        </label>
        <label className="field">
          <span>Directory (optional)</span>
          <DirField value={dir} onChange={setDir} />
          <small className="muted">Agents run here unless a message tags another directory. Empty = scratch folder.</small>
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
