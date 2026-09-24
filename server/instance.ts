export interface RunningInstance {
  app: 'agent-chat';
  pid: number;
  dataDir: string;
  startedAt: number;
}

/**
 * What is listening on 127.0.0.1:port: null (nothing), 'other' (another program) or an Agent Chat
 * instance (identified by /api/health).
 */
export async function probePort(port: number, timeoutMs = 1500): Promise<RunningInstance | 'other' | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => null)) as RunningInstance | null;
    return body?.app === 'agent-chat' && Number.isInteger(body.pid) ? body : 'other';
  } catch (e: any) {
    const code = e?.cause?.code ?? e?.code;
    if (code === 'ECONNREFUSED') return null;
    return 'other'; // something accepted the connection but did not answer like Agent Chat
  }
}

/** Asks an old instance to stop (SIGTERM = its graceful shutdown) and waits until the port is free. */
export async function replaceInstance(inst: RunningInstance, port: number, waitMs = 10000): Promise<boolean> {
  try {
    process.kill(inst.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await probePort(port, 500)) === null) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
