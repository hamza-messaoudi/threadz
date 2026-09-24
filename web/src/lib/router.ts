import { useEffect, useState } from 'react';

export interface Route {
  view: 'home' | 'conversation' | 'settings';
  conversationId?: string;
  threadId?: string;
  messageId?: string;
}

export function parseRoute(loc: Location = window.location): Route {
  const params = new URLSearchParams(loc.search);
  const m = /^\/c\/([^/]+)/.exec(loc.pathname);
  if (m) {
    return {
      view: 'conversation',
      conversationId: decodeURIComponent(m[1]),
      threadId: params.get('thread') ?? undefined,
      messageId: params.get('m') ?? undefined,
    };
  }
  if (loc.pathname.startsWith('/settings')) return { view: 'settings' };
  return { view: 'home' };
}

export function routeUrl(r: Route): string {
  if (r.view === 'conversation' && r.conversationId) {
    const q = new URLSearchParams();
    if (r.threadId) q.set('thread', r.threadId);
    if (r.messageId) q.set('m', r.messageId);
    const qs = q.toString();
    return `/c/${encodeURIComponent(r.conversationId)}${qs ? `?${qs}` : ''}`;
  }
  if (r.view === 'settings') return '/settings';
  return '/';
}

export function navigate(r: Route, replace = false) {
  const url = routeUrl(r);
  if (url === window.location.pathname + window.location.search) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new Event('routechange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute());
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('popstate', on);
    window.addEventListener('routechange', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('routechange', on);
    };
  }, []);
  return route;
}
