import { FilePlus } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Conversation, type DirResult, type Mention } from '../lib/api.ts';
import { createDir, createFirst, createOptions, tildify, type CreateOption } from '../lib/dirs.ts';
import { pickFile } from '../lib/document.ts';
import { play } from '../lib/sound.ts';
import { agentColor, useAppData } from '../lib/store.tsx';
import { useDropdown } from '../lib/useDropdown.ts';
import { useDocumentPicker } from './DocumentDrop.tsx';
import { useErrorShake } from './transitions.tsx';

interface Props {
  draftKey: string;
  conversation: Conversation | null;
  defaultAgent: string | null;
  /** Where this thread's turns run now (after any move). */
  cwd?: string;
  placeholder: string;
  onSend: (text: string, mentions: Mention[]) => Promise<void>;
  /** Shares a document here (the button, or a pasted .md or .pdf file). */
  onDocument?: (file: File) => Promise<void>;
  autoFocus?: boolean;
}

interface Item {
  kind: Mention['kind'];
  id: string;
  label: string;
  sub: string;
  badge?: string | null;
  /** "New folder" row: creates the folder, then inserts it as a directory chip. */
  create?: CreateOption;
}

interface Trigger {
  char: '@' | '#';
  query: string;
  node: Text;
  start: number;
  end: number;
}

const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

function loadDraft(key: string): { text: string; mentions: Mention[] } | null {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function saveDraft(key: string, v: { text: string; mentions: Mention[] } | null) {
  try {
    if (v && v.text.trim()) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

const dirChipTitle = (kind: 'dir' | 'cd') =>
  kind === 'cd' ? 'Moves this thread here · click to only reference it' : 'Referenced: the agent can read it · click to move into it';

/** Flips a directory chip between reference and move; a message moves at most once. */
function toggleDirChip(root: HTMLElement, chip: HTMLElement) {
  const kind = chip.dataset.kind === 'cd' ? 'dir' : 'cd';
  if (kind === 'cd') root.querySelectorAll<HTMLElement>('[data-kind="cd"]').forEach((c) => setDirKind(c, 'dir'));
  setDirKind(chip, kind);
}
function setDirKind(chip: HTMLElement, kind: 'dir' | 'cd') {
  chip.dataset.kind = kind;
  chip.className = `mention-chip ${kind}`;
  chip.dataset.tooltip = dirChipTitle(kind);
}

function chipEl(kind: Mention['kind'], id: string, label: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.className = `mention-chip ${kind}`;
  chip.dataset.kind = kind;
  chip.dataset.id = id;
  chip.dataset.label = label;
  chip.textContent = label;
  if (kind === 'agent') chip.style.color = agentColor(id);
  if (kind === 'dir' || kind === 'cd') chip.dataset.tooltip = dirChipTitle(kind);
  return chip;
}

/** Reads the editor into plain text plus mention spans (offsets into that text). */
function serialize(root: HTMLElement): { text: string; mentions: Mention[] } {
  let text = '';
  const mentions: Mention[] = [];
  const walk = (node: Node, top: boolean) => {
    node.childNodes.forEach((child, i) => {
      if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data.replace(/ /g, ' ');
      else if (child instanceof HTMLElement) {
        if (child.dataset.kind) {
          const label = child.dataset.label ?? child.textContent ?? '';
          mentions.push({ kind: child.dataset.kind as Mention['kind'], id: child.dataset.id!, start: text.length, end: text.length + label.length });
          text += label;
        } else if (child.tagName === 'BR') text += '\n';
        else {
          if ((child.tagName === 'DIV' || child.tagName === 'P') && (i > 0 || !top)) text += '\n';
          walk(child, false);
        }
      }
    });
  };
  walk(root, true);
  return { text, mentions };
}

function restore(root: HTMLElement, draft: { text: string; mentions: Mention[] }) {
  root.innerHTML = '';
  let pos = 0;
  const pushText = (s: string) => {
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) root.appendChild(document.createElement('br'));
      if (p) root.appendChild(document.createTextNode(p));
    });
  };
  for (const m of [...draft.mentions].sort((a, b) => a.start - b.start)) {
    pushText(draft.text.slice(pos, m.start));
    root.appendChild(chipEl(m.kind, m.id, draft.text.slice(m.start, m.end)));
    pos = m.end;
  }
  pushText(draft.text.slice(pos));
}

function placeCaretAtEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

export function Composer({ draftKey, conversation, defaultAgent, cwd, placeholder, onSend, onDocument, autoFocus }: Props) {
  const { config, upsertConversation } = useAppData();
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<{ text: string; mentions: Mention[] }>({ text: '', mentions: [] });
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirLabels, setDirLabels] = useState<Record<string, string>>({});
  const [yoloInit, setYoloInit] = useState<string | null>(null);
  const shake = useErrorShake<HTMLDivElement>(error, () => setError(null));
  const [attaching, setAttaching] = useState(false);
  const attach = async (file: File) => {
    if (!onDocument || attaching) return;
    setAttaching(true);
    setError(null);
    try {
      await onDocument(file);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAttaching(false);
    }
  };
  const picker = useDocumentPicker(attach);

  // Restore the draft for this conversation/thread.
  useLayoutEffect(() => {
    const el = ref.current!;
    const d = loadDraft(`draft:${draftKey}`);
    if (d) restore(el, d);
    else el.innerHTML = '';
    setValue(serialize(el));
    if (autoFocus) {
      el.focus();
      placeCaretAtEnd(el);
    }
  }, [draftKey, autoFocus]);

  // Autocomplete sources.
  useEffect(() => {
    if (!trigger) {
      setItems([]);
      return;
    }
    const q = trigger.query.toLowerCase();
    if (trigger.char === '@') {
      const list: Item[] = [
        ...(config?.agents ?? []).map((a) => ({ kind: 'agent' as const, id: a.name, label: `@${a.name}`, sub: a.description, badge: a.builtin ? 'built-in' : a.model })),
        ...(config?.workflows ?? []).map((w) => ({
          kind: 'workflow' as const,
          id: w.name,
          label: `@${w.name}`,
          sub: w.description || w.steps.map((s) => `@${s}`).join(' → '),
          badge: 'workflow',
        })),
      ];
      const scored = list
        .map((it) => ({ it, s: it.id.toLowerCase().startsWith(q) ? 0 : it.id.toLowerCase().includes(q) ? 1 : 2 }))
        .filter((x) => x.s < 2)
        .sort((a, b) => a.s - b.s || a.it.id.localeCompare(b.it.id));
      setItems(scored.map((x) => x.it).slice(0, 12));
      setSel(0);
      return;
    }
    let cancelled = false;
    api
      .get<DirResult[]>(`/api/dirs?q=${encodeURIComponent(trigger.query)}`)
      .then((res) => {
        if (cancelled) return;
        const home = config?.homeDir;
        const found: Item[] = res.map((d) => ({ kind: 'dir' as const, id: d.path, label: `#${d.name}`, sub: tildify(d.path, home), badge: d.branch }));
        const creates: Item[] = createOptions(trigger.query, config?.dirRoots ?? [], res).map((opt) => ({
            kind: 'dir' as const,
            id: `create:${opt.root}`,
            label: `＋ New folder “${opt.name}”`,
            sub: `Creates ${tildify(opt.root, home).replace(/\/+$/, '')}/${opt.name} and runs git init`,
            create: opt,
          }));
        setItems(createFirst(trigger.query, res) ? [...creates, ...found] : [...found, ...creates]);
        setSel(0);
      })
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [trigger?.char, trigger?.query, config]);

  const detectTrigger = useCallback(() => {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return setTrigger(null);
    const r = s.getRangeAt(0);
    if (r.startContainer.nodeType !== Node.TEXT_NODE || !ref.current?.contains(r.startContainer)) return setTrigger(null);
    const node = r.startContainer as Text;
    const before = node.data.slice(0, r.startOffset);
    const m = /(^|[\s( ])([@#])([\w.\-/]*)$/.exec(before);
    if (!m) return setTrigger(null);
    setTrigger({ char: m[2] as '@' | '#', query: m[3], node, start: r.startOffset - m[3].length - 1, end: r.startOffset });
  }, []);

  const onInput = () => {
    // A lone <br> left by the browser would hide the placeholder and push the caret to line 2.
    if (!ref.current!.textContent && !ref.current!.querySelector('[data-kind]')) ref.current!.innerHTML = '';
    const v = serialize(ref.current!);
    setValue(v);
    setError(null); // editing clears a failed send's error
    saveDraft(`draft:${draftKey}`, v);
    detectTrigger();
  };

  // A folder is referenced unless picked with Shift (or just created: a new project is somewhere to work in).
  const choose = async (it: Item, move = false) => {
    if (!trigger) return;
    if (it.create) {
      try {
        const d = await createDir(it.create);
        it = { kind: 'cd', id: d.path, label: `#${d.name}`, sub: d.path };
      } catch (e: any) {
        setError(e.message);
        return;
      }
    } else if (it.kind === 'dir' && move) it = { ...it, kind: 'cd' };
    const el = ref.current!;
    if (it.kind === 'dir' || it.kind === 'cd') {
      // The same folder twice is one chip; a new move replaces the old one.
      el.querySelectorAll<HTMLElement>('[data-kind="dir"], [data-kind="cd"]').forEach((n) => (n.dataset.id === it.id || (it.kind === 'cd' && n.dataset.kind === 'cd')) && n.remove());
      setDirLabels((d) => ({ ...d, [it.id]: it.label }));
    }
    const range = document.createRange();
    const len = trigger.node.data.length;
    range.setStart(trigger.node, Math.min(trigger.start, len));
    range.setEnd(trigger.node, Math.min(trigger.end, len));
    range.deleteContents();
    const chip = chipEl(it.kind, it.id, it.label);
    range.insertNode(chip);
    const space = document.createTextNode(' ');
    chip.after(space);
    const s = window.getSelection()!;
    const caret = document.createRange();
    caret.setStart(space, 1);
    caret.collapse(true);
    s.removeAllRanges();
    s.addRange(caret);
    setTrigger(null);
    onInput();
  };

  const analysis = useMemo(() => analyse(value.mentions, defaultAgent, (cwd ?? conversation?.dir) !== config?.scratchDir ? (cwd ?? conversation?.dir ?? null) : null, config?.workflows ?? [], dirLabels), [value.mentions, defaultAgent, cwd, conversation?.dir, config, dirLabels]);

  const send = async () => {
    if (sending || !value.text.trim() || analysis.blocked) return;
    setSending(true);
    setError(null);
    try {
      const lead = value.text.length - value.text.trimStart().length;
      await onSend(
        value.text.trim(),
        value.mentions.map((m) => ({ ...m, start: m.start - lead, end: m.end - lead })),
      );
      play('sent');
      saveDraft(`last:${draftKey}`, value);
      saveDraft(`draft:${draftKey}`, null);
      ref.current!.innerHTML = '';
      setValue({ text: '', mentions: [] });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (trigger && items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setSel((sel + 1) % items.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setSel((sel - 1 + items.length) % items.length);
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return choose(items[sel], e.shiftKey);
      }
    }
    if (e.key === 'Escape' && trigger) {
      e.preventDefault();
      e.stopPropagation();
      return setTrigger(null);
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      return send();
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return onInput();
    }
    if (e.key === 'ArrowUp' && !value.text.trim()) {
      const last = loadDraft(`last:${draftKey}`);
      if (last) {
        e.preventDefault();
        restore(ref.current!, last);
        placeCaretAtEnd(ref.current!);
        onInput();
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    // A file copied in the Finder pastes as a document, not as its name.
    const file = onDocument ? pickFile(e.clipboardData.files) : null;
    if (file) return void attach(file);
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };

  const toggleYolo = async () => {
    if (!conversation) return;
    upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { yolo: !conversation.yolo }));
  };

  const { shown: menuView, className: menuClass } = useDropdown(trigger ? { char: trigger.char, items, sel } : null);

  return (
    <div className={`composer-wrap ${shake.wrapClass}`}>
      {menuView && (
        <div className={`dropdown ${menuClass}`} data-origin="bottom-left" onMouseDown={(e) => e.preventDefault()}>
          {menuView.items.map((it, i) => (
            <button key={`${it.kind}:${it.id}`} className={`dd-item ${i === menuView.sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={(e) => choose(it, e.shiftKey)}>
              <span className="dd-title">
                <span style={it.kind === 'agent' ? { color: agentColor(it.id) } : undefined}>{it.kind === 'dir' && !it.create ? basename(it.id) : it.label}</span>
                {it.badge && <span className={it.kind === 'dir' ? 'branch' : 'dd-kind'}>{it.badge}</span>}
              </span>
              {it.sub && <span className="dd-sub">{it.sub}</span>}
            </button>
          ))}
          {menuView.char === '#' && menuView.items.some((it) => !it.create) && (
            <div className="dd-foot">
              <kbd>↵</kbd> reference <span className="muted">(agent stays put)</span> · <kbd>⇧↵</kbd> move into <span className="muted">(thread runs there from now on)</span>
            </div>
          )}
          {!menuView.items.length && (
            <div className="dd-empty">
              {menuView.char === '@' ? 'No matching agent or workflow' : config?.dirRoots.length ? 'Type a folder name to find it, or to create a new one' : 'No matching directory'}
            </div>
          )}
        </div>
      )}
      <div ref={shake.ref} className={`composer ${shake.inputClass} ${conversation?.yolo ? 'yolo' : ''}`}>
        <div
          ref={ref}
          className="editor"
          contentEditable
          role="textbox"
          aria-multiline
          data-placeholder={placeholder}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && detectTrigger()}
          onClick={(e) => {
            const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-kind="dir"], [data-kind="cd"]');
            if (chip) {
              toggleDirChip(ref.current!, chip);
              return onInput();
            }
            detectTrigger();
          }}
          onBlur={() => setTimeout(() => setTrigger(null), 150)}
          onPaste={onPaste}
          suppressContentEditableWarning
        />
        <div className="composer-bar">
          {onDocument && (
            <>
              <button className="attach-btn" onClick={picker.open} disabled={attaching} data-tooltip="Add a Markdown or PDF document · or drop it here" aria-label="Add a document">
                <FilePlus size={16} />
              </button>
              {picker.input}
            </>
          )}
          <span className={`hint ${analysis.blocked ? 'warn' : ''}`} title={analysis.hint}>
            {analysis.hint}
          </span>
          <span className="spacer" />
          {shake.message && <span className="error-text t-error-msg">{shake.message}</span>}
          {conversation && (
            <button
              className={`yolo-toggle t-toggle ${conversation.yolo ? 'on' : ''} ${yoloInit === conversation.id ? 'is-init' : ''}`}
              role="switch"
              aria-checked={conversation.yolo}
              data-on={conversation.yolo}
              onClick={() => {
                setYoloInit(conversation.id); // animate from the first click on, not on load or when switching chats
                toggleYolo();
              }}
              data-tooltip="YOLO lets agents change files and run write actions here"
            >
              <span className="knob">
                <span className="t-toggle-thumb" />
              </span>{' '}
              YOLO
            </button>
          )}
          <button className="send-btn" disabled={!value.text.trim() || sending || analysis.blocked} onClick={send}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function analyse(
  mentions: Mention[],
  defaultAgent: string | null,
  cwd: string | null,
  workflows: { name: string; steps: string[] }[],
  dirLabels: Record<string, string>,
): { hint: string; blocked: boolean } {
  const agents = [...new Set(mentions.filter((m) => m.kind === 'agent').map((m) => m.id))];
  const wfs = [...new Set(mentions.filter((m) => m.kind === 'workflow').map((m) => m.id))];
  const name = (id: string) => dirLabels[id]?.slice(1) ?? basename(id);
  const move = mentions.filter((m) => m.kind === 'cd').pop();
  const refs = [...new Set(mentions.filter((m) => m.kind === 'dir' && m.id !== move?.id).map((m) => name(m.id)))];
  const where = (move ? ` in ${name(move.id)} (moves this thread)` : cwd ? ` in ${basename(cwd)}` : '') + (refs.length ? ` · can read ${refs.join(', ')}` : '');
  if (wfs.length && agents.length) return { hint: 'A message can tag agents or one workflow, not both', blocked: true };
  if (wfs.length > 1) return { hint: 'Tag one workflow at a time', blocked: true };
  if (wfs.length) {
    const wf = workflows.find((w) => w.name === wfs[0]);
    return { hint: `→ workflow @${wfs[0]}${wf ? ` (${wf.steps.map((s) => '@' + s).join(' → ')})` : ''}${where}`, blocked: false };
  }
  if (agents.length) return { hint: `→ ${agents.map((a) => '@' + a).join(', ')}${where}`, blocked: false };
  if (defaultAgent) return { hint: `→ @${defaultAgent}${where}`, blocked: false };
  return { hint: 'No agent will reply. Tag one with @', blocked: false };
}
