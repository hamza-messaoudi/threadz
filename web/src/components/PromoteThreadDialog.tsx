import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Conversation, type ThreadInfo } from '../lib/api.ts';
import { slugify } from '../lib/dirs.ts';
import { navigate } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { useModal } from '../lib/useModal.ts';
import { DirField } from './DirField.tsx';
import { useErrorShake } from './transitions.tsx';

/** A channel name from the quoted passage: its first few words, without markdown punctuation. */
export function suggestChannelName(blockText: string | null): string {
  const words = (blockText ?? '')
    .replace(/```[\s\S]*?```|::[\w-]+|\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/[#>*_`~|-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
  return slugify(words).slice(0, 40).replace(/-+$/, '');
}

/**
 * "Turn into channel": the side thread becomes the root of a new channel. It keeps its id, so the
 * agents in it resume their sessions (and the prompt cache) on the next message.
 */
export function PromoteThreadDialog({ thread, from, onClose }: { thread: ThreadInfo; from: Conversation; onClose: () => void }) {
  const { upsertConversation, config } = useAppData();
  const initialDir = thread.cwd === config?.scratchDir ? null : thread.cwd;
  const [name, setName] = useState(() => suggestChannelName(thread.blockText));
  const [dir, setDir] = useState<string | null>(initialDir);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { close, modalClass, backdropClass } = useModal(onClose);
  const shake = useErrorShake<HTMLInputElement>(error, () => setError(null));
  const moved = dir !== initialDir;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<Conversation>(`/api/threads/${thread.id}/promote`, moved ? { name, dir } : { name });
      upsertConversation(c);
      close();
      navigate({ view: 'conversation', conversationId: c.id });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const source = from.kind === 'chat' ? from.name : `#${from.name}`;
  // Portalled: the thread panel it opens from is transformed while it slides, which would pin a fixed modal to it.
  return createPortal(
    <div className={backdropClass} onMouseDown={close}>
      <form className={`modal ${modalClass} ${shake.wrapClass}`} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Turn thread into a channel</h3>
        <label className="field">
          <span>Name</span>
          <input ref={shake.ref} className={shake.inputClass} autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder="e.g. index-design" />
        </label>
        <label className="field">
          <span>Directory</span>
          <DirField value={dir} onChange={setDir} />
          <small className="muted">
            {moved
              ? 'Agents carry their context into the new folder: each one forks its session on its next reply.'
              : 'Same folder as the thread, so every agent picks up its session where it left off, prompt cache included.'}
          </small>
        </label>
        <ul className="promote-facts muted">
          <li>All replies move with it. Nothing is copied or summarised.</li>
          <li>
            The passage in <strong>{source}</strong> keeps a link to the new channel.
          </li>
        </ul>
        {shake.message && <div className="error-text t-error-msg">{shake.message}</div>}
        <div className="row gap end">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy}>
            Create channel
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
