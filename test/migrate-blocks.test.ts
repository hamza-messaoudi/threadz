import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../server/db/migrate.ts';
import { Store } from '../server/db/queries.ts';
import { migrateBlocks, similarity } from '../server/scripts/migrate-blocks.ts';

function db() {
  const d = new Database(':memory:');
  migrate(d);
  return { d, store: new Store(d) };
}

function thread(store: Store, messageId: string, index: number, text: string) {
  const m = store.getMessage(messageId)!;
  return store.upsertParagraphThread(m, index, text).thread.id;
}

describe('migrate:blocks', () => {
  it('scores by words, not markdown syntax', () => {
    expect(similarity('- **a** b', '* a   b')).toBe(1);
    expect(similarity('alpha beta', 'gamma delta')).toBeLessThan(0.3);
  });

  it('re-anchors shifted and swapped threads, lists what it cannot match, and runs once', async () => {
    const { d, store } = db();
    const { rootThreadId } = store.createConversation({ kind: 'channel', name: 'c' });
    const content = 'First paragraph about caching.\n\nSecond paragraph about indexing.\n\nThird paragraph about backups.';
    const m = store.insertMessage({ thread_id: rootThreadId, author_kind: 'agent', author_id: 'a', content_md: content, status: 'done' });
    // As if the old splitter had counted differently: two threads swapped, one shifted, one orphaned.
    const a = thread(store, m.id, 1, 'First paragraph about caching.');
    const b = thread(store, m.id, 0, 'Second paragraph about indexing.');
    const c = thread(store, m.id, 5, 'Third paragraph about **backups**.');
    const lost = thread(store, m.id, 7, 'A paragraph that no longer exists anywhere.');

    const r = await migrateBlocks(d);
    expect(r).toMatchObject({ skipped: false, total: 4, moved: 3, unchanged: 0 });
    expect(r.unmatched.map((u) => u.threadId)).toEqual([lost]);
    const row = (id: string) => d.prepare('SELECT block_index, block_text FROM threads WHERE id = ?').get(id) as { block_index: number; block_text: string };
    expect(row(a)).toEqual({ block_index: 0, block_text: 'First paragraph about caching.' });
    expect(row(b)).toEqual({ block_index: 1, block_text: 'Second paragraph about indexing.' });
    expect(row(c)).toEqual({ block_index: 2, block_text: 'Third paragraph about backups.' });
    expect(row(lost).block_index).toBe(7);

    expect((await migrateBlocks(d)).skipped).toBe(true);
  });

  it('a dry run changes nothing', async () => {
    const { d, store } = db();
    const { rootThreadId } = store.createConversation({ kind: 'channel', name: 'c' });
    const m = store.insertMessage({ thread_id: rootThreadId, author_kind: 'agent', author_id: 'a', content_md: 'One.\n\nTwo.', status: 'done' });
    const id = thread(store, m.id, 0, 'Two.');
    const r = await migrateBlocks(d, { dryRun: true });
    expect(r.moved).toBe(1);
    expect((d.prepare('SELECT block_index FROM threads WHERE id = ?').get(id) as { block_index: number }).block_index).toBe(0);
    expect((await migrateBlocks(d)).skipped).toBe(false);
  });
});
