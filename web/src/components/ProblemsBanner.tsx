import { useState } from 'react';
import { useAppData } from '../lib/store.tsx';

export function ProblemsBanner() {
  const { config } = useAppData();
  const [open, setOpen] = useState(false);
  const problems = config?.problems ?? [];
  if (!problems.length) return null;
  return (
    <div className="banner warn">
      <button className="banner-head" onClick={() => setOpen(!open)}>
        <strong>Config problems ({problems.length})</strong>
        <span className="muted"> — the files below were skipped. {open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul>
          {problems.map((p, i) => (
            <li key={i}>
              <code>{p.file}</code>: {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
