import { useEffect, useRef, useState } from 'react';
import { api, type DirResult } from '../lib/api.ts';
import { createDir, createFirst, createOptions, tildify, type CreateOption } from '../lib/dirs.ts';
import { useAppData } from '../lib/store.tsx';
import { useDropdown } from '../lib/useDropdown.ts';

type Row = { kind: 'dir'; dir: DirResult } | { kind: 'create'; opt: CreateOption };

/**
 * Directory picker backed by the server's index; free-typed paths are not possible. Typing a new
 * name offers "New folder <name> in <root>", which creates it (with git init) in a configured root.
 */
export function DirField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { config } = useAppData();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DirResult[]>([]);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const home = config?.homeDir;

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

  const found: Row[] = items.map((dir) => ({ kind: 'dir' as const, dir }));
  const creates: Row[] = createOptions(q, config?.dirRoots ?? [], items).map((opt) => ({ kind: 'create' as const, opt }));
  const rows = createFirst(q, items) ? [...creates, ...found] : [...found, ...creates];
  const { shown: menuView, className: menuClass } = useDropdown(open ? { rows, sel } : null);

  const pick = async (row: Row) => {
    setError(null);
    if (row.kind === 'dir') onChange(row.dir.path);
    else {
      setBusy(true);
      try {
        onChange((await createDir(row.opt)).path);
      } catch (e: any) {
        setError(e.message);
        return;
      } finally {
        setBusy(false);
      }
    }
    setOpen(false);
    setQ('');
  };

  if (value && !open)
    return (
      <div className="dir-value">
        <code title={value}>{tildify(value, home)}</code>
        <button
          type="button"
          className="link"
          onClick={() => {
            setOpen(true);
            setTimeout(() => input.current?.focus());
          }}
        >
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
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((sel + 1) % Math.max(rows.length, 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((sel - 1 + rows.length) % Math.max(rows.length, 1));
          } else if (e.key === 'Enter' && rows[sel]) {
            e.preventDefault();
            pick(rows[sel]);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder="Search your folders, or type a new name…"
        spellCheck={false}
        disabled={busy}
      />
      {menuView && (
        <div className={`dir-dropdown ${menuClass}`} data-origin="top-left">
          {menuView.rows.map((row, i) =>
            row.kind === 'dir' ? (
              <button type="button" key={row.dir.path} className={`dd-item ${i === menuView.sel ? 'sel' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(row)}>
                <span className="dd-title">
                  {row.dir.name} {row.dir.branch && <span className="branch">{row.dir.branch}</span>} {row.dir.recent && <span className="dd-kind">recent</span>}
                </span>
                <span className="dd-sub">{tildify(row.dir.path, home)}</span>
              </button>
            ) : (
              <button
                type="button"
                key={`create:${row.opt.root}`}
                className={`dd-item create ${i === menuView.sel ? 'sel' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row)}
              >
                <span className="dd-title">
                  <span className="plus">＋</span> New folder “{row.opt.name}”
                </span>
                <span className="dd-sub">
                  Creates {tildify(row.opt.root, home).replace(/\/+$/, '')}/{row.opt.name} and runs git init
                </span>
              </button>
            ),
          )}
          {!menuView.rows.length && (
            <div className="dd-empty">
              {config?.dirRoots.length
                ? 'Type a folder name to find it, or to create a new one.'
                : 'No folders indexed. Add dirRoots to config.yaml to search and create folders.'}
            </div>
          )}
        </div>
      )}
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}
