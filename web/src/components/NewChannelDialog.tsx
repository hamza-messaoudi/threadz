import { FileMd } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { api, type Conversation } from '../lib/api.ts';
import { isMarkdownFile, pickFile, shareDocument } from '../lib/document.ts';
import { useModal } from '../lib/useModal.ts';
import { useErrorShake } from './transitions.tsx';
import { navigate } from '../lib/router.ts';
import { useAppData } from '../lib/store.tsx';
import { createDir, slugify, tildify } from '../lib/dirs.ts';
import { DirField } from './DirField.tsx';
import { useDocumentPicker } from './DocumentDrop.tsx';
import { ICONS } from './icons.tsx';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const { upsertConversation, config } = useAppData();
  const [name, setName] = useState('');
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<File | null>(null);
  const { close, modalClass, backdropClass } = useModal(onClose);
  const shake = useErrorShake<HTMLInputElement>(error, () => setError(null));

  // A channel that opens on a document; unnamed, it takes the document's title.
  const chooseDoc = async (file: File) => {
    if (!isMarkdownFile(file)) return setError(`${file.name} is not a Markdown document (.md)`);
    if (file.size > 2_000_000) return setError(`${file.name} is too large (over 2 MB)`);
    setDoc(file);
    if (!name.trim()) {
      const title = /^\s*#\s+(.+?)\s*#*\s*$/.exec((await file.text()).split('\n').find((l) => l.trim()) ?? '')?.[1];
      setName((n) => n || slugify(title ?? file.name.replace(/\.(md|markdown)$/i, '')));
    }
  };
  const picker = useDocumentPicker(chooseDoc);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<Conversation>('/api/conversations', { kind: 'channel', name, dir });
      upsertConversation(c);
      // If the document cannot be added after all, the channel still opens, on its "add a document" state.
      if (doc) await shareDocument(c.rootThreadId, doc).catch(() => null);
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
      <form
        className={`modal ${modalClass} ${shake.wrapClass}`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = pickFile(e.dataTransfer.files);
          if (file) chooseDoc(file);
        }}
      >
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
        <div className="field">
          <span>Start from a document (optional)</span>
          {doc ? (
            <div className="doc-chosen">
              <FileMd size={16} aria-hidden />
              <code>{doc.name}</code>
              <span className="muted">{Math.max(1, Math.round(doc.size / 1024)).toLocaleString()} KB</span>
              <span className="spacer" />
              <button type="button" className="btn ghost small icon-only" onClick={() => setDoc(null)} aria-label="Remove the document" data-tooltip="Remove">
                {ICONS.close}
              </button>
            </div>
          ) : (
            <button type="button" className="folder-suggestion" onClick={picker.open}>
              <FileMd size={14} aria-hidden /> Choose a Markdown file <span className="muted">or drop it here</span>
            </button>
          )}
          {picker.input}
          <small className="muted">The channel opens on the rendered document. Select any paragraph to start a thread on it.</small>
        </div>
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
