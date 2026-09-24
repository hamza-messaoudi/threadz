import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemeSetting = 'light' | 'dark' | 'system';

// Same key as the inline script in index.html, which applies the theme before first paint.
const KEY = 'agent-chat.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

export function readTheme(): ThemeSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(setting: ThemeSetting = readTheme()): void {
  const dark = setting === 'dark' || (setting === 'system' && media().matches);
  document.documentElement.classList.toggle('dark', dark);
}

function setTheme(setting: ThemeSetting): void {
  try {
    if (setting === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    // Blocked storage: the choice still applies for this visit.
  }
  applyTheme(setting);
  current = setting;
  for (const fn of listeners) fn();
}

let current: ThemeSetting | null = null;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Light, dark or system (default). Sets `.dark` on <html> and follows the OS while on system. */
export function useTheme(): [ThemeSetting, (s: ThemeSetting) => void] {
  const setting = useSyncExternalStore(subscribe, () => (current ??= readTheme()));
  useEffect(() => {
    applyTheme(setting);
    if (setting !== 'system') return;
    const mq = media();
    const on = () => applyTheme('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [setting]);
  return [setting, useCallback(setTheme, [])];
}
