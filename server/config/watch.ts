import fs from 'node:fs';

/** Watches the config folder recursively and calls `onChange` (debounced). Returns a stop function. */
export function watchConfig(configDir: string, onChange: () => void, debounceMs = 150): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  let retry: NodeJS.Timeout | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  const start = () => {
    try {
      watcher = fs.watch(configDir, { recursive: true }, fire);
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
        retry = setTimeout(start, 2000);
      });
    } catch {
      // Folder missing: poll until it appears.
      retry = setTimeout(() => {
        if (fs.existsSync(configDir)) fire();
        start();
      }, 2000);
    }
  };
  start();
  return () => {
    clearTimeout(timer);
    clearTimeout(retry);
    watcher?.close();
  };
}
