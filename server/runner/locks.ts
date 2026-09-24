import { Semaphore } from './queue.ts';

/** FIFO mutex per key, e.g. a session key (thread, agent, cwd). Idle keys are dropped. */
export class KeyedMutex {
  private locks = new Map<string, { sem: Semaphore; users: number }>();

  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    let entry = this.locks.get(key);
    if (!entry) this.locks.set(key, (entry = { sem: new Semaphore(1), users: 0 }));
    entry.users++;
    const done = () => {
      entry!.users--;
      if (!entry!.users) this.locks.delete(key);
    };
    try {
      const release = await entry.sem.acquire(signal);
      return () => {
        release();
        done();
      };
    } catch (e) {
      done();
      throw e;
    }
  }

  isLocked(key: string): boolean {
    return this.locks.has(key);
  }
}

export const sessionKey = (threadId: string, agentId: string, cwd: string) => JSON.stringify([threadId, agentId, cwd]);
