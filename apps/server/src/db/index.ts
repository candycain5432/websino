import Database from 'better-sqlite3';

import { migrate } from './schema.js';

export type Db = Database.Database;

export function openDatabase(path = process.env.WEBSINO_DB ?? 'websino.db'): Db {
  const db = new Database(path);
  // WAL lets reads proceed during writes; FOREIGN KEYS is off by default in SQLite
  // and we rely on the references above.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
