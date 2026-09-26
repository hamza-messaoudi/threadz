import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appRoot } from '../paths.ts';

export type DB = Database.Database;

// Each entry is one migration; index + 1 is the schema version it produces.
// schema.sql is version 1. Append new plain-SQL files here, never edit old ones.
const MIGRATIONS = ['schema.sql', '002-thread-ranges.sql', '003-thread-dir.sql', '004-thread-promote.sql', '005-session-pending.sql', '006-document-sessions.sql', '007-document-versions.sql'];

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
  if (current >= MIGRATIONS.length) return;
  // Table rebuilds drop a table other tables point at; SQLite's documented recipe turns foreign keys
  // off (it cannot be done inside a transaction) and checks them before committing.
  const fk = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = fs.readFileSync(path.join(appRoot, 'server', 'db', MIGRATIONS[v]), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`migration ${MIGRATIONS[v]} broke ${broken.length} foreign keys`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
}
