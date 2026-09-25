import { useState } from 'react';
import { useAppData } from '../lib/store.tsx';
import { AccChevron, Accordion, SwapText } from './transitions.tsx';

export function ProblemsBanner() {
  const { config } = useAppData();
  const [open, setOpen] = useState(false);
  const problems = config?.problems ?? [];
  if (!problems.length) return null;
  return (
    <Accordion
      open={open}
      className="banner warn"
      head={
        <button className="banner-head t-acc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <strong>Config problems ({problems.length})</strong>
          <span className="muted">
            {' '}
            — the files below were skipped. <SwapText text={open ? 'Hide' : 'Show'} />
          </span>{' '}
          <AccChevron />
        </button>
      }
    >
      <ul>
        {problems.map((p, i) => (
          <li key={i}>
            <code>{p.file}</code>: {p.message}
          </li>
        ))}
      </ul>
    </Accordion>
  );
}
