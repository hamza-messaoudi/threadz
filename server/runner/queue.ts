/** Global limit on turns running at once; extra turns wait in FIFO order. */
export class Semaphore {
  private active = 0;
  private waiters: { resolve: () => void; cancelled: boolean }[] = [];

  constructor(private max: number) {}

  setMax(max: number): void {
    this.max = Math.max(1, max);
    this.pump();
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.filter((w) => !w.cancelled).length;
  }

  /** Resolves with a release function. `signal` aborts the wait. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const w = {
        cancelled: false,
        resolve: () => {
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.pump();
          });
        },
      };
      if (signal?.aborted) return reject(new Error('cancelled'));
      signal?.addEventListener('abort', () => {
        if (!w.cancelled && this.waiters.includes(w)) {
          w.cancelled = true;
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error('cancelled'));
        }
      });
      this.waiters.push(w);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.max && this.waiters.length) {
      const w = this.waiters.shift()!;
      if (w.cancelled) continue;
      this.active++;
      w.resolve();
    }
  }
}
