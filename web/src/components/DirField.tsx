import { useEffect, useRef, useState } from 'react';
import { api, type DirResult } from '../lib/api.ts';

/** Directory picker backed by the server's index; free-typed paths are not possible. */
export function DirField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DirResult[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.get<DirResult[]>(`/api/dirs?q=${encodeURIComponent(q)}`).then((r) => {
      if (!cancelled) {
        setItems(r);
        setSel(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [q, open]);

  const pick = (d: DirResult) => {
    onChange(d.path);
    setOpen(false);
    setQ('');
  };

  if (value && !open)
    return (
      <div className="dir-value">
        <code title={value}>{value}</code>
        <button type="button" className="link" onClick={() => { setOpen(true); setTimeout(() => input.current?.focus()); }}>
          Change
        </button>
        <button type="button" className="link" onClick={() => onChange(null)}>
          Clear
        </button>
      </div>
    );

  return (
    <div className="dir-picker">
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % Math.max(items.length, 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + items.length) % Math.max(items.length, 1)); }
          else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
          else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        }}
        placeholder="Search known directories…"
        spellCheck={false}
      />
      {open && (
        <div className="dir-dropdown">
          {items.map((d, i) => (
            <button type="button" key={d.path} className={`dd-item ${i === sel ? 'sel' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(d)}>
              <span className="dd-title">
                {d.name} {d.branch && <span className="branch">{d.branch}</span>} {d.recent && <span className="dd-kind">recent</span>}
              </span>
              <span className="dd-sub">{d.path}</span>
            </button>
          ))}
          {!items.length && <div className="dd-empty">No matching directory. Add roots to dirRoots in config.yaml, then rescan in Settings.</div>}
        </div>
      )}
    </div>
  );
}
