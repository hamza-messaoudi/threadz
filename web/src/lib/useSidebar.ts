import { useEffect, useState } from 'react';

const KEY = 'agent-chat.sidebar';

/** Phones: the full list slides over the conversation instead of taking a column (styles.css). */
export const narrowScreen = () => matchMedia('(max-width: 640px)').matches;

/** Whether the sidebar is collapsed to its icon rail; remembered in this browser. Phones start on the rail. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    if (narrowScreen()) return true;
    try {
      return localStorage.getItem(KEY) === 'rail';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // Opening the overlay on a phone is not a layout choice to remember for the desktop.
    if (narrowScreen()) return;
    try {
      if (collapsed) localStorage.setItem(KEY, 'rail');
      else localStorage.removeItem(KEY);
    } catch {
      // Blocked storage: the choice still applies for this visit.
    }
  }, [collapsed]);
  return [collapsed, setCollapsed] as const;
}
