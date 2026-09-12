/**
 * Games that span more than one request.
 *
 * Dice, limbo and slots resolve in a single `POST /api/round`. Blackjack does not - a
 * hand is a conversation - and neither does crash, where the round advances with the
 * wall clock whether or not the player is watching. Both need server-held state, and
 * that state contains the answer: the shuffled shoe, and the crash point.
 *
 * Two rules make this safe:
 *
 *  1. **The stake is debited when the round opens.** A crash round that is never cashed
 *     out, or a blackjack hand abandoned mid-decision, has already cost the player.
 *     That is why sessions live in SQLite rather than in a `Map` - a restart would
 *     otherwise lose live rounds that had already been paid for.
 *  2. **Nothing leaves this file un-redacted.** `state_json` holds the secrets; every
 *     response is built by a `view` function that omits what the player has not earned.
 *     Omits, not hides: a face-down card is absent from the payload, not flagged.
 */

import { randomUUID } from 'node:crypto';

import {
  assertValidBet, blackjack, crash, shuffleShoe,
  type BlackjackView, type CrashView, type ShoeState,
} from '@websino/engine';

import type { Db } from './db/index.js';
import { applyLedger, getBalance } from './db/ledger.js';
import { takeStream } from './fair/seeds.js';

export class NoSuchSessionError extends Error {
  constructor(game: string) {
    super(`no ${game} round in progress`);
    this.name = 'NoSuchSessionError';
  }
}

/** A request that contradicts a round already in flight - a 409, not a 500. */
export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConflictError';
  }
}

interface SessionRow {
  id: string;
  game: string;
  state_json: string;
  seed_pair_id: string;
  nonce: number;
  staked: number;
  started_at: number;
}

function openSession(db: Db, userId: string, game: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, game, state_json, seed_pair_id, nonce, staked, started_at
       FROM game_sessions WHERE user_id = ? AND game = ? AND closed_at IS NULL`,
    )
    .get(userId, game) as SessionRow | undefined;
}

const saveState = (db: Db, id: string, state: unknown): void => {
  db.prepare('UPDATE game_sessions SET state_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(state), Date.now(), id);
};

const closeSession = (db: Db, id: string): void => {
  db.prepare('UPDATE game_sessions SET closed_at = ? WHERE id = ?').run(Date.now(), id);
};

/** Record a finished round for the audit log and the player's statistics. */
function recordRound(
  db: Db,
  userId: string,
  game: string,
  session: { seed_pair_id: string; nonce: number },
  staked: number,
  payout: number,
  config: unknown,
  detail: unknown,
): string {
  const roundId = randomUUID();
  const now = Date.now();
  const net = payout - staked;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO rounds (id, user_id, game, seed_pair_id, nonce, bet, payout,
                           config_json, outcome_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      roundId, userId, game, session.seed_pair_id, session.nonce, staked, payout,
      JSON.stringify(config), JSON.stringify(detail), now,
    );
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
      userId, game, staked, payout,
      net > 0 ? 1 : 0, net < 0 ? 1 : 0, net === 0 ? 1 : 0,
      Math.max(0, net), staked,
    );
  })();
  return roundId;
}

// ---------------------------------------------------------------------- crash --

interface CrashState {
  round: crash.CrashRound;
  startedAt: number;
}

/**
 * The tick a round is on right now, by the *server's* clock.
 *
 * The client never says when it cashed out - it says only *that* it did, and the server
 * dates the request itself. Latency therefore costs the player a little (they must act
 * slightly early), which is the honest direction for that error to point.
 */
const tickNow = (startedAt: number, now = Date.now()): number =>
  Math.max(0, Math.floor((now - startedAt) / crash.TICK_MS));

function crashView(db: Db, userId: string, state: CrashState, reveal: boolean): CrashView {
  const { round } = state;
  const base: CrashView = {
    state: round.state,
    bet: round.bet,
    autoCashOut: round.autoCashOut,
    startedAt: state.startedAt,
    tickMs: crash.TICK_MS,
    balance: getBalance(db, userId),
  };
  if (!reveal) return base;
  const result = crash.settle(round);
  return {
    ...base,
    crashPoint: round.crashPoint,
    cashedMultiplier: round.cashedMultiplier,
    payout: result.payout,
  };
}

/** Settle an open crash round that has already run its course, if one exists. */
function reapCrash(db: Db, userId: string): void {
  const row = openSession(db, userId, 'crash');
  if (!row) return;
  const state = JSON.parse(row.state_json) as CrashState;
  const settled = crash.resolveAt(state.round, tickNow(state.startedAt));
  if (settled.state === 'running') return;
  finishCrash(db, userId, row, { ...state, round: settled });
}

function finishCrash(db: Db, userId: string, row: SessionRow, state: CrashState): CrashView {
  const result = crash.settle(state.round);
  saveState(db, row.id, state);
  if (result.payout > 0) {
    applyLedger(db, userId, [{ delta: result.payout, reason: 'payout' }]);
  }
  recordRound(
    db, userId, 'crash', row, row.staked, result.payout,
    { autoCashOut: state.round.autoCashOut }, result.detail,
  );
  closeSession(db, row.id);
  return crashView(db, userId, state, true);
}

export function startCrashRound(
  db: Db,
  userId: string,
  bet: number,
  autoCashOut: number | null,
): CrashView {
  reapCrash(db, userId);
  if (openSession(db, userId, 'crash')) {
    throw new SessionConflictError('a crash round is already running');
  }
  assertValidBet(bet, getBalance(db, userId));
  if (autoCashOut !== null && (!Number.isInteger(autoCashOut) || autoCashOut < 101)) {
    throw new SessionConflictError('auto cash-out must be at least 1.01x');
  }

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const round = crash.startCrash(bet, stream, autoCashOut);
  const state: CrashState = { round, startedAt: Date.now() };

  applyLedger(db, userId, [{ delta: -bet, reason: 'wager' }]);
  db.prepare(
    `INSERT INTO game_sessions (id, user_id, game, state_json, seed_pair_id, nonce,
                                staked, started_at, updated_at)
     VALUES (?, ?, 'crash', ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), userId, JSON.stringify(state), seedPairId, nonce,
    bet, state.startedAt, state.startedAt,
  );

  return crashView(db, userId, state, false);
}

export function cashOutCrash(db: Db, userId: string): CrashView {
  const row = openSession(db, userId, 'crash');
  if (!row) throw new NoSuchSessionError('crash');
  const state = JSON.parse(row.state_json) as CrashState;
  const settled = crash.cashOutAt(state.round, tickNow(state.startedAt));
  return finishCrash(db, userId, row, { ...state, round: settled });
}

/** Poll: settles the round if the curve has already died, otherwise reports progress. */
export function crashStatus(db: Db, userId: string): CrashView | null {
  const row = openSession(db, userId, 'crash');
  if (!row) return null;
  const state = JSON.parse(row.state_json) as CrashState;
  const settled = crash.resolveAt(state.round, tickNow(state.startedAt));
  if (settled.state !== 'running') {
    return finishCrash(db, userId, row, { ...state, round: settled });
  }
  return crashView(db, userId, state, false);
}

// ------------------------------------------------------------------ blackjack --

interface BlackjackState {
  shoe: ShoeState;
  round: blackjack.BlackjackRound | null;
}

function blackjackView(db: Db, userId: string, row: SessionRow, state: BlackjackState): BlackjackView {
  const round = state.round;
  const seed = db
    .prepare('SELECT server_seed_hash FROM seed_pairs WHERE id = ?')
    .get(row.seed_pair_id) as { server_seed_hash: string };
  const proof = { serverSeedHash: seed.server_seed_hash, nonce: row.nonce };

  if (!round) {
    return {
      phase: 'done', hands: [], dealer: [], dealerTotal: null, holeHidden: false,
      activeIndex: 0, actions: [], insuranceOffered: false, insuranceCost: 0,
      insuranceBet: 0, insurancePayout: 0, staked: 0, returned: 0,
      balance: getBalance(db, userId),
      cardsRemaining: state.shoe.cards.length - state.shoe.position,
      proof,
    };
  }

  // Redaction, not obfuscation: while the hole card is down it never enters the payload,
  // so a player with the developer console open learns exactly as much as one without.
  const dealer = round.holeHidden ? round.dealer.slice(0, 1) : [...round.dealer];

  return {
    phase: round.phase,
    hands: round.hands.map((hand) => ({
      cards: [...hand.cards],
      bet: hand.bet,
      doubled: hand.doubled,
      fromSplit: hand.fromSplit,
      label: blackjack.handLabel(hand),
      total: blackjack.totalOf(hand.cards),
      outcome: hand.outcome,
      payout: hand.payout,
    })),
    dealer,
    dealerTotal: round.holeHidden ? null : blackjack.dealerTotal(round),
    holeHidden: round.holeHidden,
    activeIndex: round.activeIndex,
    actions: blackjack.availableActions(round),
    insuranceOffered: round.phase === 'insurance',
    insuranceCost: blackjack.insuranceCost(round),
    insuranceBet: round.insuranceBet,
    insurancePayout: round.insurancePayout,
    staked: round.staked,
    returned: round.returned,
    balance: getBalance(db, userId),
    cardsRemaining: state.shoe.cards.length - state.shoe.position,
    proof,
  };
}

/**
 * Load the blackjack session, shuffling a fresh shoe under a fresh commitment if there
 * is none or the cut card is out. The commitment is per shoe, so a new shoe means a new
 * nonce - that is the thing the player verifies.
 */
function loadBlackjack(db: Db, userId: string): { row: SessionRow; state: BlackjackState } {
  const existing = openSession(db, userId, 'blackjack');
  if (existing) {
    const state = JSON.parse(existing.state_json) as BlackjackState;
    if (!blackjack.roundNeedsShuffle(state.shoe)) return { row: existing, state };
    // Cut card is out and the last hand is finished - retire this shoe.
    closeSession(db, existing.id);
  }

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const state: BlackjackState = { shoe: shuffleShoe(stream, 6, 0.75), round: null };
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO game_sessions (id, user_id, game, state_json, seed_pair_id, nonce,
                                staked, started_at, updated_at)
     VALUES (?, ?, 'blackjack', ?, ?, ?, 0, ?, ?)`,
  ).run(id, userId, JSON.stringify(state), seedPairId, nonce, now, now);

  return {
    row: { id, game: 'blackjack', state_json: JSON.stringify(state), seed_pair_id: seedPairId, nonce, staked: 0, started_at: now },
    state,
  };
}

export function dealBlackjack(db: Db, userId: string, bet: number): BlackjackView {
  assertValidBet(bet, getBalance(db, userId));
  const { row, state } = loadBlackjack(db, userId);
  if (state.round && state.round.phase !== 'done') {
    throw new SessionConflictError('finish the hand in progress first');
  }

  applyLedger(db, userId, [{ delta: -bet, reason: 'wager' }]);
  state.round = blackjack.deal(state.shoe, bet);
  saveState(db, row.id, state);

  if (state.round.phase === 'done') settleBlackjack(db, userId, row, state);
  return blackjackView(db, userId, row, state);
}

export function insureBlackjack(db: Db, userId: string, buy: boolean): BlackjackView {
  const row = openSession(db, userId, 'blackjack');
  if (!row) throw new NoSuchSessionError('blackjack');
  const state = JSON.parse(row.state_json) as BlackjackState;
  if (!state.round) throw new NoSuchSessionError('blackjack');

  const cost = blackjack.insuranceCost(state.round);
  if (buy) assertValidBet(cost, getBalance(db, userId));
  state.round = blackjack.takeInsurance(state.round, buy);
  if (buy) applyLedger(db, userId, [{ delta: -cost, reason: 'wager' }]);
  saveState(db, row.id, state);

  if (state.round.phase === 'done') settleBlackjack(db, userId, row, state);
  return blackjackView(db, userId, row, state);
}

export function actBlackjack(
  db: Db,
  userId: string,
  action: blackjack.Action,
): BlackjackView {
  const row = openSession(db, userId, 'blackjack');
  if (!row) throw new NoSuchSessionError('blackjack');
  const state = JSON.parse(row.state_json) as BlackjackState;
  if (!state.round) throw new NoSuchSessionError('blackjack');

  // Doubling and splitting cost more chips, and the engine tracks that in `staked`.
  // Charging the difference means a player can never commit chips they do not have.
  const before = state.round.staked;
  state.round = blackjack.act(state.round, action, state.shoe);
  const extra = state.round.staked - before;
  if (extra > 0) {
    assertValidBet(extra, getBalance(db, userId));
    applyLedger(db, userId, [{ delta: -extra, reason: 'wager' }]);
  }
  saveState(db, row.id, state);

  if (state.round.phase === 'done') settleBlackjack(db, userId, row, state);
  return blackjackView(db, userId, row, state);
}

function settleBlackjack(db: Db, userId: string, row: SessionRow, state: BlackjackState): void {
  const round = state.round as blackjack.BlackjackRound;
  if (round.returned > 0) {
    applyLedger(db, userId, [{ delta: round.returned, reason: 'payout' }]);
  }
  recordRound(
    db, userId, 'blackjack', row, round.staked, round.returned,
    { decks: round.rules.decks },
    {
      hands: round.hands.map((h) => ({ cards: h.cards, outcome: h.outcome, payout: h.payout })),
      dealer: round.dealer,
      insuranceBet: round.insuranceBet,
      insurancePayout: round.insurancePayout,
    },
  );
  saveState(db, row.id, state);
}

export function blackjackStatus(db: Db, userId: string): BlackjackView | null {
  const row = openSession(db, userId, 'blackjack');
  if (!row) return null;
  return blackjackView(db, userId, row, JSON.parse(row.state_json) as BlackjackState);
}
