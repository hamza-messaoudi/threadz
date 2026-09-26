import { PencilSimple, Warning } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, type Message } from '../lib/api.ts';
import { documentApi, editorName, type DocConflict, type DocOp } from '../lib/document.ts';
import { play } from '../lib/sound.ts';
import { SwapText, useErrorShake } from './transitions.tsx';

/** What is being edited: blocks from..to of the document (all of them for the whole text). */
export interface Editing {
  from: number;
  to: number;
  whole: boolean;
  /** The version the text was taken from. */
  base: number;
  /** The text as it was, and where it starts in that version. */
  original: string;
  at: number;
  draft: string;
  /** "handbook.md", or the section: “Its heading”. */
  label: string;
}

interface Props {
  docId: string;
  name: string;
  editing: Editing;
  /** The version on the server now (it moves on when someone else saves meanwhile). */
  version: number;
  onDraft: (draft: string) => void;
  onClose: () => void;
  onSaved: (m: Message) => void;
  /**
   * A section conflict: the same section in the newer version, to put the draft in place of. Null when
   * it cannot be found there (its heading changed or went).
   */
  relocate: () => { text: string; at: number } | null;
}

/**
 * The Markdown source of a document or one of its sections, in place of the rendered text. ⌘↵ saves,
 * Esc cancels (a second Esc when there are changes). A save that finds a newer version on the server
 * keeps the draft and says who saved what, with the ways forward: nothing is dropped silently.
 */
export function DocEditor({ docId, name, editing, version, onDraft, onClose, onSaved, relocate }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<DocConflict | null>(null);
  const [armed, setArmed] = useState(false);
  const shake = useErrorShake<HTMLDivElement>(error, () => setError(null));
  const dirty = editing.draft !== editing.original;
  const newer = version > editing.base;

  // Grows with its text, so the page scrolls rather than a box inside it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [editing.draft]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(0, 0);
  }, []);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);

  const save = async (over?: { base: number; find?: { text: string; at: number } }) => {
    if (saving) return;
    if (!dirty && !over) return onClose();
    setSaving(true);
    setError(null);
    setConflict(null);
    const base = over?.base ?? editing.base;
    const ops: DocOp[] | undefined = editing.whole ? undefined : [{ find: over?.find?.text ?? editing.original, replace: editing.draft, at: over?.find?.at ?? editing.at }];
    try {
      const r = await documentApi.save(docId, editing.whole ? { base, content: editing.draft } : { base, ops });
      play('sent');
      onSaved(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.current) setConflict({ message: e.message, version: e.body.current.version, editedBy: e.body.current.editedBy });
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      // Before the thread panel and the document menus see it.
      e.preventDefault();
      e.stopPropagation();
      if (!dirty || armed) onClose();
      else setArmed(true);
    }
  };

  const hint = saving
    ? 'Saving…'
    : armed
      ? 'Press Esc again to discard your changes'
      : newer
        ? `Version ${version} was saved while you edit; saving checks it first`
        : `Markdown · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}↵ to save · Esc to cancel`;
  const moved = conflict && !editing.whole ? relocate() : null;

  return (
    <div className={`doc-editor ${shake.wrapClass}`} data-whole={editing.whole}>
      <div ref={shake.ref} className={`doc-editor-frame ${shake.inputClass}`}>
        <div className="doc-editor-head">
          <PencilSimple size={14} aria-hidden />
          <span className="doc-editor-title">Editing {editing.label}</span>
          <span className="doc-editor-version">version {editing.base}</span>
        </div>
        <textarea
          ref={area}
          className="doc-editor-text"
          value={editing.draft}
          spellCheck
          aria-label={`Markdown of ${editing.label}`}
          onChange={(e) => {
            setArmed(false);
            onDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="doc-editor-foot">
          {conflict && (
            <div className="doc-conflict" role="alert">
              <Warning size={16} aria-hidden />
              <div className="doc-conflict-body">
                <strong>
                  {editorName(conflict.editedBy)} saved version {conflict.version} while you were editing.
                </strong>
                <span>
                  {editing.whole
                    ? 'Your text is kept here. Saving it replaces theirs, which stays in the history.'
                    : moved
                      ? 'They changed this section too. Your text is kept here; put it in place of their section, which stays in the history.'
                      : 'Their version no longer has this section as it was. Your text is kept here: copy it before you close.'}
                </span>
                <div className="doc-conflict-actions">
                  {editing.whole && (
                    <button className="btn small primary" disabled={saving} onClick={() => save({ base: conflict.version })}>
                      Save mine over theirs
                    </button>
                  )}
                  {moved && (
                    <button className="btn small primary" disabled={saving} onClick={() => save({ base: conflict.version, find: moved })}>
                      Replace their section with mine
                    </button>
                  )}
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(editing.draft)}>
                    Copy my text
                  </button>
                  <button className="btn small ghost" onClick={onClose}>
                    Discard mine
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="doc-editor-bar">
            <SwapText className="doc-editor-hint" text={hint} />
            <span className="spacer" />
            <button className="btn small ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="btn small primary" onClick={() => save()} disabled={saving || !dirty || !!conflict}>
              <SwapText text={saving ? 'Saving' : 'Save'} />
            </button>
          </div>
        </div>
      </div>
      <p className="t-error-msg doc-editor-error">{shake.message}</p>
    </div>
  );
}
