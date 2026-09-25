import { lazy, Suspense, useEffect, useState } from 'react';
import { ConversationView } from './components/ConversationView.tsx';
import { ProblemsBanner } from './components/ProblemsBanner.tsx';
import { SearchPalette } from './components/SearchPalette.tsx';
import { Settings } from './components/Settings.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TooltipLayer } from './components/TooltipLayer.tsx';
import { TextsReveal } from './components/transitions.tsx';
import { navigate, useRoute } from './lib/router.ts';
import { AppDataProvider, useAppData } from './lib/store.tsx';
import { narrowScreen, useSidebarCollapsed } from './lib/useSidebar.ts';
import { useTheme } from './lib/useTheme.ts';

// Not linked from the UI; loaded only when /dev/markdown is opened.
const StyleLab = lazy(() => import('./components/dev/StyleLab.tsx'));

export function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { conversations } = useAppData();
  const [modal, setModal] = useState<null | 'search' | 'new-channel'>(null);
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  useTheme(); // keeps .dark in sync with the OS while the setting is "system"

  // Ctrl/Cmd+K opens search; Ctrl/Cmd+B or Ctrl/Cmd+\ collapses the sidebar to a rail.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setModal((m) => (m === 'search' ? null : 'search'));
      } else if (key === 'b' || key === '\\') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // On a phone the open sidebar covers the conversation: picking somewhere to go closes it.
  useEffect(() => {
    if (narrowScreen()) setCollapsed(true);
  }, [route.view, route.conversationId]);

  const conversation = route.conversationId ? conversations.find((c) => c.id === route.conversationId) : undefined;

  return (
    <div className={`app ${collapsed ? 'side-collapsed' : ''}`}>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        activeId={route.conversationId}
        onSearch={() => setModal('search')}
        newChannelOpen={modal === 'new-channel'}
        setNewChannelOpen={(o) => setModal(o ? 'new-channel' : null)}
      />
      <main className="main">
        <ProblemsBanner />
        {route.view === 'conversation' && route.conversationId ? (
          <ConversationView key={route.conversationId} conversationId={route.conversationId} conversation={conversation} route={route} />
        ) : route.view === 'settings' ? (
          <Settings />
        ) : route.view === 'dev-markdown' ? (
          <Suspense fallback={null}>
            <StyleLab />
          </Suspense>
        ) : (
          <Home onNewChannel={() => setModal('new-channel')} />
        )}
      </main>
      {modal === 'search' && <SearchPalette onClose={() => setModal(null)} />}
      <TooltipLayer />
    </div>
  );
}

function Home({ onNewChannel }: { onNewChannel: () => void }) {
  return (
    <TextsReveal className="empty-state">
      <h2 className="t-stagger-line t-stagger-line--1">Agent Chat</h2>
      <p className="t-stagger-line t-stagger-line--2">Pick a channel on the left, start a new chat, or create a channel for a project.</p>
      <div className="t-stagger-line t-stagger-line--3">
        <div className="row gap">
          <button className="btn primary" onClick={onNewChannel}>
            New channel
          </button>
          <button className="btn" onClick={() => navigate({ view: 'home' })}>
            Refresh
          </button>
        </div>
      </div>
    </TextsReveal>
  );
}
