import { useEffect, useState } from 'react';
import { api, type Conversation } from '../lib/api.ts';
import { useModal } from '../lib/useModal.ts';
import { useErrorShake } from './transitions.tsx';
import { navigate } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { createDir, slugify, tildify } from '../lib/dirs.ts';
import { DirField } from './DirField.tsx';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const { upsertConversation, config } = useAppData();
  const [name, setName] = useState('');
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { close, modalClass, backdropClass } = useModal(onClose);
  const shake = useErrorShake<HTMLInputElement>(error, () => setError(null));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<Conversation>('/api/conversations', { kind: 'channel', name, dir });
      upsertConversation(c);
      close();
      navigate({ view: 'conversation', conversationId: c.id });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={backdropClass} onMouseDown={close}>
      <form className={`modal ${modalClass} ${shake.wrapClass}`} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>New channel</h3>
        <label className="field">
          <span>Name</span>
          <input ref={shake.ref} className={shake.inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. main-repo" />
        </label>
        <label className="field">
          <span>Directory (optional)</span>
          <DirField value={dir} onChange={setDir} />
          <FolderSuggestion name={name} roots={config?.dirRoots ?? []} home={config?.homeDir} hidden={!!dir} onCreated={setDir} onError={setError} />
          <small className="muted">Agents run here unless a message tags another directory. Empty = scratch folder.</small>
        </label>
        {shake.message && <div className="error-text t-error-msg">{shake.message}</div>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={close}>
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

/** One-click "start a fresh project folder" named after the channel, when no folder is picked yet. */
function FolderSuggestion(props: { name: string; roots: string[]; home?: string; hidden: boolean; onCreated: (p: string) => void; onError: (e: string) => void }) {
  const slug = slugify(props.name);
  const [exists, setExists] = useState(false);
  const root = props.roots[0];
  useEffect(() => {
    if (!slug || !root) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await api.get<{ path: string }[]>(`/api/dirs?q=${encodeURIComponent(slug)}`);
      if (!cancelled) setExists(res.some((r) => r.path === `${root.replace(/\/+$/, '')}/${slug}`));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slug, root]);
  if (props.hidden || !slug || !root) return null;
  const target = `${tildify(root, props.home).replace(/\/+$/, '')}/${slug}`;
  return (
    <button
      type="button"
      className="folder-suggestion"
      onClick={async () => {
        try {
          props.onCreated((await createDir({ root, name: slug })).path);
        } catch (e: any) {
          props.onError(e.message);
        }
      }}
    >
      {exists ? (
        <>Use existing folder <code>{target}</code></>
      ) : (
        <>
          <span className="plus">＋</span> Start a new project folder <code>{target}</code> <span className="muted">(git init)</span>
        </>
      )}
    </button>
  );
}
