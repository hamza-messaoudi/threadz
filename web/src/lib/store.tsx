import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ConfigInfo, type Conversation, type RoutineInfo } from './api.ts';
import { useSse } from './sse.ts';

interface AppData {
  config: ConfigInfo | null;
  conversations: Conversation[];
  routines: RoutineInfo[];
  refreshConversations: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  refreshRoutines: () => Promise<void>;
  upsertConversation: (c: Conversation) => void;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);

  const refreshConfig = useCallback(async () => setConfig(await api.get<ConfigInfo>('/api/config')), []);
  const refreshConversations = useCallback(async () => setConversations(await api.get<Conversation[]>('/api/conversations')), []);
  const refreshRoutines = useCallback(async () => {
    try {
      setRoutines(await api.get<RoutineInfo[]>('/api/routines'));
    } catch {
      setRoutines([]);
    }
  }, []);

  const upsertConversation = useCallback((c: Conversation) => {
    setConversations((list) => {
      const rest = list.filter((x) => x.id !== c.id);
      return c.archived ? rest : [...rest, c];
    });
  }, []);

  const refreshAll = useCallback(() => {
    refreshConfig();
    refreshConversations();
    refreshRoutines();
  }, [refreshConfig, refreshConversations, refreshRoutines]);

  useEffect(refreshAll, [refreshAll]);

  useSse(
    '/api/events',
    (event, data) => {
      if (event === 'conversation.updated') upsertConversation(data);
      else if (event === 'config.changed') {
        refreshConfig();
        refreshRoutines();
      } else if (event === 'routine.status') refreshRoutines();
    },
    refreshAll,
    true,
  );

  const value = useMemo(
    () => ({ config, conversations, routines, refreshConversations, refreshConfig, refreshRoutines, upsertConversation }),
    [config, conversations, routines, refreshConversations, refreshConfig, refreshRoutines, upsertConversation],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppDataProvider missing');
  return v;
}

const PALETTE = ['#5b5bd6', '#0d9488', '#d97706', '#db2777', '#2563eb', '#65a30d', '#9333ea', '#dc2626', '#0891b2', '#ca8a04'];

/** Stable per-agent colour derived from the name. */
export function agentColor(name: string | null | undefined): string {
  if (!name) return 'var(--muted)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
