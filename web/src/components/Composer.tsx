import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Conversation, type DirResult, type Mention } from '../lib/api.ts';
import { agentColor, useAppData } from '../lib/store.tsx';

interface Props {
  draftKey: string;
  conversation: Conversation | null;
  defaultAgent: string | null;
  placeholder: string;
  onSend: (text: string, mentions: Mention[]) => Promise<void>;
  autoFocus?: boolean;
}

interface Item {
  kind: Mention['kind'];
  id: string;
  label: string;
  sub: string;
  badge?: string | null;
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

function chipEl(kind: Mention['kind'], id: string, label: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.className = `mention-chip ${kind}`;
  chip.dataset.kind = kind;
  chip.dataset.id = id;
  chip.dataset.label = label;
  chip.textContent = label;
  if (kind === 'agent') chip.style.color = agentColor(id);
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

export function Composer({ draftKey, conversation, defaultAgent, placeholder, onSend, autoFocus }: Props) {
  const { config, upsertConversation } = useAppData();
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<{ text: string; mentions: Mention[] }>({ text: '', mentions: [] });
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirLabels, setDirLabels] = useState<Record<string, string>>({});

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
        setItems(res.map((d) => ({ kind: 'dir', id: d.path, label: `#${d.name}`, sub: d.path, badge: d.branch })));
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
    saveDraft(`draft:${draftKey}`, v);
    detectTrigger();
  };

  const choose = (it: Item) => {
    if (!trigger) return;
    const el = ref.current!;
    if (it.kind === 'dir') {
      // One directory per message: a new one replaces the old chip.
      el.querySelectorAll('[data-kind="dir"]').forEach((n) => n.remove());
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

  const analysis = useMemo(() => analyse(value.mentions, defaultAgent, conversation, config?.workflows ?? [], dirLabels), [value.mentions, defaultAgent, conversation, config, dirLabels]);

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
        return choose(items[sel]);
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
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };

  const toggleYolo = async () => {
    if (!conversation) return;
    upsertConversation(await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { yolo: !conversation.yolo }));
  };

  return (
    <div className="composer-wrap">
      {trigger && (
        <div className="dropdown" onMouseDown={(e) => e.preventDefault()}>
          {items.map((it, i) => (
            <button key={`${it.kind}:${it.id}`} className={`dd-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(it)}>
              <span className="dd-title">
                <span style={it.kind === 'agent' ? { color: agentColor(it.id) } : undefined}>{it.kind === 'dir' ? basename(it.id) : it.label}</span>
                {it.badge && <span className={it.kind === 'dir' ? 'branch' : 'dd-kind'}>{it.badge}</span>}
              </span>
              {it.sub && <span className="dd-sub">{it.sub}</span>}
            </button>
          ))}
          {!items.length && <div className="dd-empty">{trigger.char === '@' ? 'No matching agent or workflow' : 'No matching directory'}</div>}
        </div>
      )}
      <div className={`composer ${conversation?.yolo ? 'yolo' : ''}`}>
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
          onClick={detectTrigger}
          onBlur={() => setTimeout(() => setTrigger(null), 150)}
          onPaste={onPaste}
          suppressContentEditableWarning
        />
        <div className="composer-bar">
          <span className={`hint ${analysis.blocked ? 'warn' : ''}`} title={analysis.hint}>
            {analysis.hint}
          </span>
          <span className="spacer" />
          {error && <span className="error-text">{error}</span>}
          {conversation && (
            <button className={`yolo-toggle ${conversation.yolo ? 'on' : ''}`} onClick={toggleYolo} title="YOLO lets agents change files and run write actions in this conversation">
              <span className="knob" /> YOLO
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
  conversation: Conversation | null,
  workflows: { name: string; steps: string[] }[],
  dirLabels: Record<string, string>,
): { hint: string; blocked: boolean } {
  const agents = [...new Set(mentions.filter((m) => m.kind === 'agent').map((m) => m.id))];
  const wfs = [...new Set(mentions.filter((m) => m.kind === 'workflow').map((m) => m.id))];
  const dir = mentions.find((m) => m.kind === 'dir');
  const where = dir ? ` in ${dirLabels[dir.id]?.slice(1) ?? basename(dir.id)}` : conversation?.dir ? ` in ${basename(conversation.dir)}` : '';
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
