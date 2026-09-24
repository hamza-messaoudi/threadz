export type HubListener = (event: string, data: unknown) => void;

/** In-memory pub/sub for Server-Sent Events. Topics: "global" and "thread:<id>". */
export class Hub {
  private topics = new Map<string, Set<HubListener>>();
  /** Observes every publish (used to derive secondary events). */
  tap?: (topic: string, event: string, data: unknown) => void;

  subscribe(topic: string, fn: HubListener): () => void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.topics.delete(topic);
    };
  }

  publish(topic: string, event: string, data: unknown): void {
    this.tap?.(topic, event, data);
    for (const fn of this.topics.get(topic) ?? []) {
      try {
        fn(event, data);
      } catch {
        // a broken subscriber must not affect the others
      }
    }
  }

  thread(threadId: string, event: string, data: unknown): void {
    this.publish(`thread:${threadId}`, event, data);
  }

  global(event: string, data: unknown): void {
    this.publish('global', event, data);
  }
}
