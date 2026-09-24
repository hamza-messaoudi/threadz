import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appRoot } from '../paths.ts';

export type DB = Database.Database;

// Each entry is one migration; index + 1 is the schema version it produces.
// schema.sql is version 1. Append new plain-SQL files here, never edit old ones.
const MIGRATIONS = ['schema.sql'];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = fs.readFileSync(path.join(appRoot, 'server', 'db', MIGRATIONS[v]), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
