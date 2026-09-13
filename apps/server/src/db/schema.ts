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
  {
    id: 2,
    name: 'game_sessions',
    sql: `
      -- Multi-request games: blackjack (a hand spans several decisions) and crash
      -- (a round spans wall-clock time). state_json holds SECRETS - the shuffled shoe
      -- and the crash point - and is never sent to a client. Every response is built
      -- by a redaction function that omits what the player has not earned yet.
      --
      -- Persisted rather than held in memory because the stake is debited the moment
      -- a round opens: a restart with in-memory state would silently eat live bets.
      CREATE TABLE game_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game         TEXT NOT NULL,
        state_json   TEXT NOT NULL,
        seed_pair_id TEXT NOT NULL REFERENCES seed_pairs(id),
        nonce        INTEGER NOT NULL,
        staked       INTEGER NOT NULL DEFAULT 0,
        started_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        closed_at    INTEGER
      );
      -- At most one open session per game per player.
      CREATE UNIQUE INDEX game_sessions_open
        ON game_sessions(user_id, game) WHERE closed_at IS NULL;
    `,
  },
  {
    id: 3,
    name: 'rooms',
    sql: `
      -- Shared tables. Unlike a single-player session these are *live* - they tick on a
      -- timer whether or not anyone is looking - but they are still snapshotted here
      -- after every mutation, for the same reason: a seat's buy-in has already left its
      -- owner's wallet, so a restart that lost the room would strand real stacks.
      --
      -- state_json holds the shuffled deck and every player's hole cards. It is never
      -- sent anywhere; each connection gets a redacted view built per seat.
      CREATE TABLE rooms (
        id         TEXT PRIMARY KEY,
        game       TEXT NOT NULL,
        name       TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- What each seated account has bought in for, so leaving can only ever return
      -- chips that were actually debited. One row per occupied seat.
      CREATE TABLE room_seats (
        room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        seat       INTEGER NOT NULL,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        buy_in     INTEGER NOT NULL,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (room_id, seat)
      );
      -- One seat per account across the whole floor: no playing yourself.
      CREATE UNIQUE INDEX room_seats_user ON room_seats(user_id);
    `,
  },
  {
    id: 4,
    name: 'bingo_entries',
    sql: `
      -- What each player staked in a bingo round.
      --
      -- Bingo has no seats, so it needs its own version of room_seats, and for the same
      -- reason: a round pays out from the tick, minutes after the chips were debited and
      -- possibly after a restart, so the payout has to be reconciled against a row that
      -- proves the debit happened. payout IS NULL means "staked, not yet settled" - and a
      -- row still NULL for a round the room is no longer running is refunded at start-up,
      -- which is the only way a lost snapshot can strand chips.
      CREATE TABLE bingo_entries (
        room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        round     INTEGER NOT NULL,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cards     INTEGER NOT NULL,
        stake     INTEGER NOT NULL,
        staked    INTEGER NOT NULL,
        payout    INTEGER,
        bought_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, round, user_id)
      );
      -- One buy per player per round, so a top-up cannot double-debit under a race.
      CREATE INDEX bingo_entries_open ON bingo_entries(room_id, round) WHERE payout IS NULL;
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
