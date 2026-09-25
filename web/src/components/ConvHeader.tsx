import { useEffect, useRef, useState } from 'react';
import { api, type Conversation } from '../lib/api.ts';
import { tildify } from '../lib/dirs.ts';
import { useAppData } from '../lib/store.tsx';
import { DirField } from './DirField.tsx';
import { ICONS } from './icons.tsx';
import { useErrorShake } from './transitions.tsx';

/** The conversation's name, edited in place: Enter or leaving the field saves, Esc puts it back. */
export function EditableTitle({ conversation }: { conversation: Conversation }) {
  const { upsertConversation } = useAppData();
  const [name, setName] = useState(conversation.name);
  const [error, setError] = useState<string | null>(null);
  const shake = useErrorShake<HTMLInputElement>(error, () => setError(null));
  const skip = useRef(false);

  useEffect(() => setName(conversation.name), [conversation.name]);

  const save = async () => {
    const next = name.trim();
    if (!next || next === conversation.name) return setName(conversation.name);
    try {
      upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { name: next }));
    } catch (e: any) {
      setError(e.message);
      setName(conversation.name);
    }
  };

  return (
    <h2 className={`conv-title ${shake.wrapClass}`}>
      {conversation.kind !== 'chat' && <span className="hash">#</span>}
      {/* The sizer holds the width, so the input grows with the name. */}
      <span className="conv-title-field" data-value={name || ' '}>
        <input
          ref={shake.ref}
          className={shake.inputClass}
          value={name}
          size={1}
          spellCheck={false}
          aria-label={`${conversation.kind === 'chat' ? 'Chat' : 'Channel'} name`}
          data-tooltip={conversation.kind === 'chat' ? 'Rename chat' : 'Rename channel'}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => (skip.current ? (skip.current = false) : save())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              skip.current = true;
              setName(conversation.name);
              e.currentTarget.blur();
            }
          }}
        />
      </span>
    </h2>
  );
}

/** A channel's default folder, with a pencil that opens the folder picker in place. */
export function DirButton({ conversation }: { conversation: Conversation }) {
  const { upsertConversation, config } = useAppData();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const save = async (dir: string | null) => {
    setError(null);
    try {
      upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { dir }));
      setOpen(false);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const label = conversation.dir ? tildify(conversation.dir, config?.homeDir) : 'scratch folder';
  return (
    <div className="dir-edit" ref={box}>
      <button
        className={`dir-edit-btn ${conversation.dir ? '' : 'empty'}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-tooltip={open ? undefined : 'Change the folder new sessions run in'}
      >
        <span className="dir-edit-path" title={conversation.dir ?? undefined}>
          {label}
        </span>
        <span className="dir-edit-icon">{ICONS.pencil}</span>
      </button>
      {open && (
        <div className="dir-pop">
          <div className="dir-pop-head">
            <span>Default folder</span>
            {conversation.dir && (
              <button className="link" onClick={() => save(null)}>
                Use scratch folder
              </button>
            )}
          </div>
          <DirField value={null} onChange={(v) => v && save(v)} autoFocus />
          {error && <small className="error-text">{error}</small>}
        </div>
      )}
    </div>
  );
}
