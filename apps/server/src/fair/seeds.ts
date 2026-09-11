/**
 * Server seeds live here and nowhere else.
 *
 * `server_seed` is only ever read by two functions in this file: one to draw a round,
 * and one to reveal a retired seed. It is never selected into anything client-bound -
 * a CI test greps every response body for the active seed to keep it that way.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { commit, FAIR_VERSION, FairStream } from '@websino/fair';

import type { Db } from '../db/index.js';

export interface PublicSeedState {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  fairVersion: number;
  previous?: {
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    rounds: number;
  };
}

interface SeedRow {
  id: string;
  server_seed: string;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  fair_version: number;
}

const newServerSeed = (): string => randomBytes(32).toString('hex');

function insertSeedPair(db: Db, userId: string, clientSeed: string): SeedRow {
  const serverSeed = newServerSeed();
  const row: SeedRow = {
    id: randomUUID(),
    server_seed: serverSeed,
    server_seed_hash: commit(serverSeed),
    client_seed: clientSeed,
    nonce: 0,
    fair_version: FAIR_VERSION,
  };
  db.prepare(
    `INSERT INTO seed_pairs
       (id, user_id, server_seed, server_seed_hash, client_seed, nonce, fair_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, userId, row.server_seed, row.server_seed_hash,
    row.client_seed, row.nonce, row.fair_version, Date.now(),
  );
  return row;
}

/** The active (unrevealed) seed pair, creating one on first use. */
export function activeSeedPair(db: Db, userId: string): SeedRow {
  const row = db
    .prepare(
      `SELECT id, server_seed, server_seed_hash, client_seed, nonce, fair_version
       FROM seed_pairs WHERE user_id = ? AND revealed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId) as SeedRow | undefined;
  return row ?? insertSeedPair(db, userId, 'websino');
}

/** Public view - deliberately omits `server_seed`. */
export function publicState(db: Db, userId: string): PublicSeedState {
  const active = activeSeedPair(db, userId);
  const revealed = db
    .prepare(
      `SELECT server_seed, server_seed_hash, client_seed, nonce
       FROM seed_pairs WHERE user_id = ? AND revealed_at IS NOT NULL
       ORDER BY revealed_at DESC LIMIT 1`,
    )
    .get(userId) as
    | { server_seed: string; server_seed_hash: string; client_seed: string; nonce: number }
    | undefined;

  return {
    serverSeedHash: active.server_seed_hash,
    clientSeed: active.client_seed,
    nonce: active.nonce,
    fairVersion: active.fair_version,
    ...(revealed
      ? {
          previous: {
            serverSeed: revealed.server_seed,
            serverSeedHash: revealed.server_seed_hash,
            clientSeed: revealed.client_seed,
            rounds: revealed.nonce,
          },
        }
      : {}),
  };
}

/**
 * Build the stream for the next round and consume its nonce.
 * The only other place `server_seed` is read is `rotate`, which reveals it.
 */
export function takeStream(db: Db, userId: string): { stream: FairStream; seedPairId: string; nonce: number } {
  const active = activeSeedPair(db, userId);
  const nonce = active.nonce;
  db.prepare('UPDATE seed_pairs SET nonce = nonce + 1 WHERE id = ?').run(active.id);
  return {
    stream: new FairStream({
      serverSeed: active.server_seed,
      clientSeed: active.client_seed,
      nonce,
    }),
    seedPairId: active.id,
    nonce,
  };
}

export function setClientSeed(db: Db, userId: string, clientSeed: string): PublicSeedState {
  const clean = clientSeed.trim().slice(0, 256) || 'websino';
  const active = activeSeedPair(db, userId);
  // Changing the client seed restarts the round counter; the server seed is untouched,
  // so the commitment the player was shown still stands.
  db.prepare('UPDATE seed_pairs SET client_seed = ?, nonce = 0 WHERE id = ?').run(clean, active.id);
  return publicState(db, userId);
}

export function rotate(db: Db, userId: string): PublicSeedState {
  const active = activeSeedPair(db, userId);
  db.transaction(() => {
    db.prepare('UPDATE seed_pairs SET revealed_at = ? WHERE id = ?').run(Date.now(), active.id);
    insertSeedPair(db, userId, active.client_seed);
  })();
  return publicState(db, userId);
}
