import { useEffect, useState } from 'react';

const KEY = 'agent-chat.sidebar';

/** Whether the sidebar is collapsed to its icon rail; remembered in this browser. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === 'rail';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      if (collapsed) localStorage.setItem(KEY, 'rail');
      else localStorage.removeItem(KEY);
    } catch {
      // Blocked storage: the choice still applies for this visit.
    }
  }, [collapsed]);
  return [collapsed, setCollapsed] as const;
}
