// One-off: re-anchor paragraph threads created with the old marked-based block split onto Comark's
// blocks. Not part of the server runtime. Usage: npm run migrate:blocks [-- --db <file>] [--dry-run] [--force]
import Database from 'better-sqlite3';
import { blocksOf } from '../../shared/markdown.ts';
import { openDb } from '../db/migrate.ts';
import { resolvePaths } from '../paths.ts';

const DONE_KEY = 'migrate_blocks_comark';

export interface MigrateResult {
  skipped: boolean;
  total: number;
  moved: number;
  unchanged: number;
  unmatched: { threadId: string; messageId: string; blockIndex: number; blockText: string; reason: string }[];
}

/** Lowercase words only, so markdown syntax differences between the two splitters do not count. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Dice coefficient over character bigrams of the normalised text (0..1). */
export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) grams.set(x.slice(i, i + 2), (grams.get(x.slice(i, i + 2)) ?? 0) + 1);
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (x.length - 1 + y.length - 1);
}

const THRESHOLD = 0.6;

export async function migrateBlocks(db: Database.Database, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<MigrateResult> {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const done = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(DONE_KEY) as { value: string } | undefined;
  const result: MigrateResult = { skipped: false, total: 0, moved: 0, unchanged: 0, unmatched: [] };
  if (done && !opts.force) return { ...result, skipped: true };

  const threads = db
    .prepare(
      `SELECT t.id, t.parent_message_id, t.block_index, t.block_text, m.content_md
       FROM threads t JOIN messages m ON m.id = t.parent_message_id
       WHERE t.parent_message_id IS NOT NULL AND t.block_end = t.block_index ORDER BY t.parent_message_id, t.block_index`,
    )
    .all() as { id: string; parent_message_id: string; block_index: number; block_text: string | null; content_md: string }[];
  result.total = threads.length;

  // Decide per parent message, so two threads never claim the same block.
  const byMessage = new Map<string, typeof threads>();
  for (const t of threads) byMessage.set(t.parent_message_id, [...(byMessage.get(t.parent_message_id) ?? []), t]);
  const updates: { id: string; message: string; index: number; text: string }[] = [];

  for (const [messageId, list] of byMessage) {
    let blocks: string[];
    try {
      blocks = await blocksOf(list[0].content_md);
    } catch (e) {
      for (const t of list) result.unmatched.push({ threadId: t.id, messageId, blockIndex: t.block_index, blockText: t.block_text ?? '', reason: `parse failed: ${(e as Error).message}` });
      continue;
    }
    const taken = new Set<number>();
    const plans: { t: (typeof list)[number]; index: number | null; score: number }[] = [];
    for (const t of list) {
      let best = -1;
      let score = 0;
      blocks.forEach((b, i) => {
        const s = similarity(t.block_text ?? '', b);
        // Ties go to the old index.
        if (s > score || (s === score && s > 0 && i === t.block_index)) {
          best = i;
          score = s;
        }
      });
      plans.push({ t, index: score >= THRESHOLD ? best : null, score });
    }
    // Best matches claim first.
    for (const p of [...plans].sort((a, b) => b.score - a.score)) {
      if (p.index === null || taken.has(p.index)) {
        result.unmatched.push({
          threadId: p.t.id,
          messageId,
          blockIndex: p.t.block_index,
          blockText: p.t.block_text ?? '',
          reason: p.index === null ? `no block above ${THRESHOLD} similarity (best ${p.score.toFixed(2)})` : `block ${p.index} already taken`,
        });
        taken.add(p.t.block_index); // it keeps its index
        continue;
      }
      taken.add(p.index);
      if (p.index === p.t.block_index && blocks[p.index] === p.t.block_text) result.unchanged++;
      else {
        result.moved++;
        updates.push({ id: p.t.id, message: messageId, index: p.index, text: blocks[p.index] });
      }
    }
  }

  if (!opts.dryRun) {
    db.transaction(() => {
      // Park moved threads on negative indices first so swaps do not trip UNIQUE(parent_message_id, block_index, block_end).
      const park = db.prepare(`UPDATE threads SET block_index = ?, block_end = ? WHERE id = ?`);
      updates.forEach((u, i) => park.run(-1 - i, -1 - i, u.id));
      const set = db.prepare(`UPDATE threads SET block_index = ?, block_end = ?, block_text = ? WHERE id = ?`);
      for (const u of updates) set.run(u.index, u.index, u.text, u.id);
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(DONE_KEY, JSON.stringify({ at: Date.now(), moved: result.moved, unmatched: result.unmatched.length }));
    })();
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--db');
  const file = i >= 0 ? args[i + 1] : resolvePaths().dbFile;
  const db = openDb(file);
  const r = await migrateBlocks(db, { dryRun: args.includes('--dry-run'), force: args.includes('--force') });
  db.close();
  if (r.skipped) console.log(`${file}: already migrated (use --force to run again).`);
  else {
    console.log(`${file}${args.includes('--dry-run') ? ' (dry run)' : ''}: ${r.total} threads, ${r.moved} re-anchored, ${r.unchanged} unchanged, ${r.unmatched.length} unmatched.`);
    for (const u of r.unmatched) console.log(`  unmatched thread ${u.threadId} (message ${u.messageId}, block ${u.blockIndex}): ${u.reason}\n    ${JSON.stringify(u.blockText.slice(0, 120))}`);
  }
}
