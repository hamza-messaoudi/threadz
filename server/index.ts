import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

const { app, ctx } = createApp();
const port = ctx.port;

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(`agent-chat listening on http://127.0.0.1:${port}/?t=${ctx.token}`);
  if (process.env.AGENT_CHAT_DEV) console.log(`dev UI: http://localhost:5173/?t=${ctx.token}`);
  for (const p of ctx.cfg.problems) console.warn(`config problem: ${p.file}: ${p.message}`);
  ctx.start();
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
