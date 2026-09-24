import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { api } from './lib/api.ts';
import './styles.css';
import './styles/markdown.css';

function Boot() {
  const [state, setState] = useState<'checking' | 'ok' | 'locked'>('checking');

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(location.search);
      const t = params.get('t');
      if (t) {
        // Move the token from the URL into an HttpOnly cookie, then drop it from history.
        await api.post('/api/login', { token: t }).catch(() => undefined);
        params.delete('t');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
      }
      try {
        await api.get('/api/session');
        setState('ok');
      } catch {
        setState('locked');
      }
    })();
  }, []);

  if (state === 'checking') return null;
  if (state === 'locked') {
    return (
      <div className="locked">
        <div className="locked-card">
          <h1>Agent Chat</h1>
          <p>Open the link printed in the terminal where the server started. It looks like</p>
          <code>http://127.0.0.1:4777/?t=…</code>
        </div>
      </div>
    );
  }
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
