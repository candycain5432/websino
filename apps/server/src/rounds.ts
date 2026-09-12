/**
 * Playing a round, server-side.
 *
 * The client sends an intent (game, bet, config) and nothing else. The server draws
 * the outcome from a seed the client has never seen, settles through the ledger, and
 * records an audit row. A forged request can change what you bet on - never what
 * you are dealt.
 */

import { randomUUID } from 'node:crypto';

import {
  assertValidBet, dice, limbo, plinko, roulette, slots, wheel, type RoundGame,
} from '@websino/engine';

import type { Db } from './db/index.js';
import { applyLedger, getBalance } from './db/ledger.js';
import { takeStream } from './fair/seeds.js';

export const GAMES: Record<string, RoundGame<never, unknown>> = {
  dice: dice as unknown as RoundGame<never, unknown>,
  limbo: limbo as unknown as RoundGame<never, unknown>,
  slots: slots as unknown as RoundGame<never, unknown>,
  roulette: roulette as unknown as RoundGame<never, unknown>,
  plinko: plinko as unknown as RoundGame<never, unknown>,
  wheel: wheel as unknown as RoundGame<never, unknown>,
};

export interface PlayResult {
  payout: number;
  multiplier: number;
  detail: unknown;
  balance: number;
  roundId: string;
  proof: { serverSeedHash: string; clientSeed: string; nonce: number; fairVersion: number };
}

export function playRound(
  db: Db,
  userId: string,
  gameId: string,
  bet: number,
  config: unknown,
): PlayResult {
  const game = GAMES[gameId];
  if (!game) throw new Error(`unknown game: ${gameId}`);

  // Validate the stake against the *server's* balance, and the config against the
  // game's own rules - never against anything the client asserted.
  assertValidBet(bet, getBalance(db, userId));
  game.validateConfig(config as never);

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const outcome = game.play(config as never, bet, stream);
  const roundId = randomUUID();

  // Stake and payout are two ledger entries in one transaction, so a round can never
  // half-settle: the wager is never taken without the payout being considered.
  const balance = applyLedger(db, userId, [
    { delta: -bet, reason: 'wager', roundId },
    ...(outcome.payout > 0
      ? [{ delta: outcome.payout, reason: 'payout' as const, roundId }]
      : []),
  ]);

  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO rounds (id, user_id, game, seed_pair_id, nonce, bet, payout,
                           config_json, outcome_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      roundId, userId, gameId, seedPairId, nonce, bet, outcome.payout,
      JSON.stringify(config), JSON.stringify(outcome.detail), now,
    );

    const net = outcome.payout - bet;
    db.prepare(
      `INSERT INTO game_stats (user_id, game, rounds, wagered, returned, wins, losses,
                               pushes, biggest_win, biggest_bet)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game) DO UPDATE SET
         rounds      = rounds + 1,
         wagered     = wagered + excluded.wagered,
         returned    = returned + excluded.returned,
         wins        = wins + excluded.wins,
         losses      = losses + excluded.losses,
         pushes      = pushes + excluded.pushes,
         biggest_win = MAX(biggest_win, excluded.biggest_win),
         biggest_bet = MAX(biggest_bet, excluded.biggest_bet)`,
    ).run(
      userId, gameId, bet, outcome.payout,
      net > 0 ? 1 : 0, net < 0 ? 1 : 0, net === 0 ? 1 : 0,
      Math.max(0, net), bet,
    );
  })();

  const seed = db
    .prepare('SELECT server_seed_hash, client_seed, fair_version FROM seed_pairs WHERE id = ?')
    .get(seedPairId) as {
    server_seed_hash: string;
    client_seed: string;
    fair_version: number;
  };

  return {
    payout: outcome.payout,
    multiplier: outcome.multiplier,
    detail: outcome.detail,
    balance,
    roundId,
    proof: {
      serverSeedHash: seed.server_seed_hash,
      clientSeed: seed.client_seed,
      nonce,
      fairVersion: seed.fair_version,
    },
  };
}
