import fs from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config/load.ts';
import { probePort, replaceInstance } from './instance.ts';
import { resolvePaths } from './paths.ts';

const replace = process.argv.includes('--replace') || process.env.AGENT_CHAT_REPLACE === '1';
const paths = resolvePaths();
const port = loadConfig(paths.configDir).config.port;

function readToken(): string | null {
  try {
    return fs.readFileSync(paths.tokenFile, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Refuses to start on a busy port, unless --replace stops an older Agent Chat first. */
async function ensurePortFree(): Promise<void> {
  const found = await probePort(port);
  if (found === null) return;
  if (found === 'other') {
    console.error(`Port ${port} is used by another program. Stop it, or set another "port" in ${paths.configDir}/config.yaml.`);
    process.exit(1);
  }
  const since = new Date(found.startedAt).toLocaleString();
  const sameData = found.dataDir === paths.dataDir;
  if (replace) {
    console.log(`Stopping the Agent Chat already running on port ${port} (pid ${found.pid}, started ${since})…`);
    if (await replaceInstance(found, port)) return;
    console.error(`pid ${found.pid} did not release port ${port} within 10 s. Stop it manually: kill ${found.pid}`);
    process.exit(1);
  }
  const token = sameData ? readToken() : null;
  console.log(
    [
      `Agent Chat is already running on port ${port} (pid ${found.pid}, started ${since}).`,
      sameData && token ? `Open it: http://127.0.0.1:${port}/?t=${token}` : `It uses a different data folder: ${found.dataDir}`,
      `To restart it with this build: npm start -- --replace   (or: kill ${found.pid})`,
    ].join('\n'),
  );
  process.exit(sameData ? 0 : 1);
}

await ensurePortFree();

const { app, ctx } = createApp({ configDir: paths.configDir, dataDir: paths.dataDir });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(`agent-chat listening on http://127.0.0.1:${port}/?t=${ctx.token}`);
  if (process.env.AGENT_CHAT_DEV) console.log(`dev UI: http://localhost:5173/?t=${ctx.token}`);
  for (const p of ctx.cfg.problems) console.warn(`config problem: ${p.file}: ${p.message}`);
  ctx.start();
});

// Another process grabbed the port between the check and listen(): exit cleanly instead of crashing.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} became busy while starting. Run again, or use: npm start -- --replace`);
  else console.error(e);
  ctx.close();
  process.exit(1);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  ctx.shutdown();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
