import { useEffect, useRef, useState } from 'react';
import { api, type SearchResult } from '../lib/api.ts';
import { useModal } from '../lib/useModal.ts';
import { navigate } from '../lib/router.ts';
import { cleanSnippet } from '../lib/snippet.ts';
import { agentColor } from '../lib/store.tsx';

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const { close, modalClass, backdropClass } = useModal(onClose);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) {
          setResults(r);
          setSel(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const open = (r: SearchResult) => {
    close();
    navigate({ view: 'conversation', conversationId: r.conversationId, threadId: r.inThread ? r.threadId : undefined, messageId: r.messageId });
  };

  return (
    <div className={backdropClass} onMouseDown={close}>
      <div className={`modal palette ${modalClass}`} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages…  in:#channel  from:@agent  from:me"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter' && results[sel]) open(results[sel]);
          }}
        />
        <div className="palette-results" ref={list}>
          {results.map((r, i) => (
            <button key={r.messageId} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => open(r)}>
              <div className="palette-meta">
                <span>{r.conversationKind === 'chat' ? r.conversationName : `#${r.conversationName}`}</span>
                {r.inThread && <span>in thread</span>}
                <span style={r.authorKind === 'agent' ? { color: agentColor(r.authorId) } : undefined}>
                  {r.authorKind === 'agent' ? `@${r.authorId}` : r.authorKind === 'user' ? 'you' : r.authorId}
                </span>
                <span>{new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="palette-snippet" dangerouslySetInnerHTML={{ __html: cleanSnippet(r.snippet) }} />
            </button>
          ))}
          {q.trim() && !loading && !results.length && <div className="dd-empty">No messages found.</div>}
        </div>
        <div className="palette-foot">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
