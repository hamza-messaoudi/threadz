// One interval per period for every clock figure (graph-timer, graph-countdown), stopped while the tab is
// hidden and resumed with an immediate tick when it shows again.
type Listener = (now: number) => void;

const groups = new Map<number, { listeners: Set<Listener>; id: number | null }>();

function tick(period: number) {
  const now = Date.now();
  for (const fn of groups.get(period)?.listeners ?? []) fn(now);
}

function sync(period: number) {
  const g = groups.get(period);
  if (!g) return;
  const run = g.listeners.size > 0 && document.visibilityState !== 'hidden';
  if (run && g.id === null) g.id = window.setInterval(() => tick(period), period);
  if (!run && g.id !== null) {
    window.clearInterval(g.id);
    g.id = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    for (const period of groups.keys()) {
      sync(period);
      if (document.visibilityState === 'visible') tick(period);
    }
  });
}

export function subscribeTicker(fn: Listener, period = 1000): () => void {
  let g = groups.get(period);
  if (!g) groups.set(period, (g = { listeners: new Set(), id: null }));
  g.listeners.add(fn);
  sync(period);
  return () => {
    g!.listeners.delete(fn);
    sync(period);
  };
}

/** Intervals currently running (tests). */
export const activeTickers = () => [...groups.values()].filter((g) => g.id !== null).length;
