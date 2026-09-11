/**
 * Schema and migrations.
 *
 * Deliberately hand-written SQL against better-sqlite3 rather than an ORM: the schema
 * is small, every query in the server is visible in one place, and there is no codegen
 * step to review. Columns stay inside the Postgres-compatible subset (TEXT ids, INTEGER
 * epoch-ms timestamps) so moving off SQLite later is mechanical.
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        password_hash  TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      -- chips here is a CACHE of SUM(ledger.delta). The ledger is the truth;
      -- a test and a startup audit assert the two agree.
      CREATE TABLE wallets (
        user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        chips      INTEGER NOT NULL,
        peak_chips INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Append-only. Nothing in the codebase may UPDATE or DELETE from this table.
      CREATE TABLE ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        delta         INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        reason        TEXT NOT NULL,
        round_id      TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX ledger_user ON ledger(user_id, id);

      CREATE TABLE seed_pairs (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_seed      TEXT NOT NULL,
        server_seed_hash TEXT NOT NULL,
        client_seed      TEXT NOT NULL,
        nonce            INTEGER NOT NULL DEFAULT 0,
        fair_version     INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        revealed_at      INTEGER
      );
      CREATE INDEX seed_pairs_user ON seed_pairs(user_id, created_at);

      CREATE TABLE rounds (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game         TEXT NOT NULL,
        seed_pair_id TEXT NOT NULL REFERENCES seed_pairs(id),
        nonce        INTEGER NOT NULL,
        bet          INTEGER NOT NULL,
        payout       INTEGER NOT NULL,
        config_json  TEXT NOT NULL,
        outcome_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX rounds_user ON rounds(user_id, created_at DESC);

      CREATE TABLE game_stats (
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game           TEXT NOT NULL,
        rounds         INTEGER NOT NULL DEFAULT 0,
        wagered        INTEGER NOT NULL DEFAULT 0,
        returned       INTEGER NOT NULL DEFAULT 0,
        wins           INTEGER NOT NULL DEFAULT 0,
        losses         INTEGER NOT NULL DEFAULT 0,
        pushes         INTEGER NOT NULL DEFAULT 0,
        biggest_win    INTEGER NOT NULL DEFAULT 0,
        biggest_bet    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, game)
      );
    `,
  },
];

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT id FROM migrations').all().map((row) => (row as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        Date.now(),
      );
    })();
  }
}
