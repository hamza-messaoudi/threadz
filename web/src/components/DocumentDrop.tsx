import { FileText } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { isDocumentFile, pickFile } from '../lib/document.ts';
import { usePresence } from '../lib/usePresence.ts';

type DropState = { kind: 'drag' } | { kind: 'busy'; name: string } | { kind: 'error'; message: string };

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

/**
 * Drag a Markdown file over a conversation to share it there. `bind` goes on the drop target; `overlay`
 * says what will happen, then that the file is being added, or why it was not. `run` shares a file
 * picked another way (a button, a paste) with the same feedback.
 */
export function useDocumentDrop(onFile: (file: File) => Promise<void>, where: string) {
  const [state, setState] = useState<DropState | null>(null);
  const depth = useRef(0);

  useEffect(() => {
    if (state?.kind !== 'error') return;
    const t = setTimeout(() => setState(null), 3200);
    return () => clearTimeout(t);
  }, [state]);

  const run = async (file: File) => {
    if (!isDocumentFile(file)) return setState({ kind: 'error', message: `${file.name} is not a document. Only Markdown (.md) and PDF files can be added.` });
    setState({ kind: 'busy', name: file.name });
    try {
      await onFile(file);
      setState(null);
    } catch (e: any) {
      setState({ kind: 'error', message: e.message });
    }
  };

  const bind = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setState((s) => (s?.kind === 'busy' ? s : { kind: 'drag' }));
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e) || --depth.current > 0) return;
      depth.current = 0;
      setState((s) => (s?.kind === 'drag' ? null : s));
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      const file = pickFile(e.dataTransfer.files);
      if (file) run(file);
      else setState(null);
    },
  };

  // transitions.dev modal timing: in at --modal-open-dur, out quicker.
  const { shown, phase } = usePresence(state, '--modal-close-dur', 150);
  const overlay = shown && (
    <div className={`doc-drop ${phase === 'open' ? 'is-open' : ''} ${shown.kind}`} role="status" aria-live="polite">
      <div className="doc-drop-card">
        <FileText size={28} className="doc-drop-icon" aria-hidden />
        {shown.kind === 'drag' ? (
          <>
            <strong>Drop to read it here</strong>
            <span className="muted">A Markdown or PDF document {where}. Select any paragraph to start a thread on it.</span>
          </>
        ) : shown.kind === 'busy' ? (
          <strong className="doc-drop-busy">Adding {shown.name}…</strong>
        ) : (
          <strong className="doc-drop-error">{shown.message}</strong>
        )}
      </div>
    </div>
  );
  return { bind, overlay, run, busy: state?.kind === 'busy' };
}

/** A hidden file input for documents (Markdown, PDF); `open` shows the system picker. */
export function useDocumentPicker(onFile: (file: File) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept=".md,.markdown,text/markdown,.pdf,application/pdf"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // the same file can be picked again
        if (file) onFile(file);
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}
