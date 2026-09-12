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

import { createCasualSource } from '@websino/fair';
import {
  assertValidBet, blackjack, crash, holdem, mines, shuffleShoe, videopoker,
  type BlackjackView, type CrashView, type HoldemSeatView, type HoldemView,
  type MinesView, type ShoeState, type VideoPokerView,
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

// ---------------------------------------------------------------------- mines --

interface MinesState {
  round: mines.MinesRound;
}

/**
 * The board is laid at `start` and the map stays here until the round ends.
 *
 * `reveal` answers one tile at a time - the only shape that keeps the server honest
 * without handing the client the board. Sending the grid and asking the UI not to look
 * would make the game a formality.
 */
function minesView(db: Db, userId: string, row: SessionRow, state: MinesState): MinesView {
  const round = state.round;
  const seed = db
    .prepare('SELECT server_seed_hash FROM seed_pairs WHERE id = ?')
    .get(row.seed_pair_id) as { server_seed_hash: string };

  const view: MinesView = {
    state: round.state,
    bet: round.bet,
    mines: round.mines,
    revealed: [...round.revealed],
    picks: round.revealed.length,
    multiplier: mines.currentMultiplier(round),
    payout: mines.currentPayout(round),
    nextMultiplier: mines.nextMultiplier(round),
    balance: getBalance(db, userId),
    proof: { serverSeedHash: seed.server_seed_hash, nonce: row.nonce },
  };

  // Only once the round is over does the map become public.
  if (round.state === 'playing') return view;
  return { ...view, minePositions: [...round.minePositions], hitPosition: round.hitPosition };
}

function finishMines(db: Db, userId: string, row: SessionRow, state: MinesState): MinesView {
  const payout = mines.currentPayout(state.round);
  saveState(db, row.id, state);
  if (payout > 0) applyLedger(db, userId, [{ delta: payout, reason: 'payout' }]);
  recordRound(
    db, userId, 'mines', row, row.staked, payout,
    { mines: state.round.mines },
    {
      revealed: state.round.revealed,
      minePositions: state.round.minePositions,
      hitPosition: state.round.hitPosition,
      state: state.round.state,
    },
  );
  closeSession(db, row.id);
  return minesView(db, userId, row, state);
}

export function startMinesRound(
  db: Db,
  userId: string,
  bet: number,
  mineCount: number,
): MinesView {
  if (openSession(db, userId, 'mines')) {
    throw new SessionConflictError('finish the board in progress first');
  }
  assertValidBet(bet, getBalance(db, userId));

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const state: MinesState = { round: mines.startMines(bet, mineCount, stream) };
  const id = randomUUID();
  const now = Date.now();

  applyLedger(db, userId, [{ delta: -bet, reason: 'wager' }]);
  db.prepare(
    `INSERT INTO game_sessions (id, user_id, game, state_json, seed_pair_id, nonce,
                                staked, started_at, updated_at)
     VALUES (?, ?, 'mines', ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, JSON.stringify(state), seedPairId, nonce, bet, now, now);

  return minesView(
    db, userId,
    { id, game: 'mines', state_json: '', seed_pair_id: seedPairId, nonce, staked: bet, started_at: now },
    state,
  );
}

export function revealMinesTile(db: Db, userId: string, position: number): MinesView {
  const row = openSession(db, userId, 'mines');
  if (!row) throw new NoSuchSessionError('mines');
  const state = JSON.parse(row.state_json) as MinesState;
  state.round = mines.reveal(state.round, position);
  saveState(db, row.id, state);

  // A bomb ends it; so does clearing the board, which cashes out at the top rung.
  if (state.round.state !== 'playing') return finishMines(db, userId, row, state);
  return minesView(db, userId, row, state);
}

export function cashOutMines(db: Db, userId: string): MinesView {
  const row = openSession(db, userId, 'mines');
  if (!row) throw new NoSuchSessionError('mines');
  const state = JSON.parse(row.state_json) as MinesState;
  state.round = mines.cashOut(state.round);
  return finishMines(db, userId, row, state);
}

export function minesStatus(db: Db, userId: string): MinesView | null {
  const row = openSession(db, userId, 'mines');
  if (!row) return null;
  return minesView(db, userId, row, JSON.parse(row.state_json) as MinesState);
}

// ----------------------------------------------------------------- videopoker --

interface VideoPokerState {
  round: videopoker.VideoPokerRound;
}

/**
 * The whole deck is shuffled at `deal`, so the replacements are fixed before the player
 * chooses holds. It must therefore never leave the server while the hand is live - the
 * view sends the five cards on the table and nothing else.
 */
function videoPokerView(
  db: Db,
  userId: string,
  row: SessionRow,
  state: VideoPokerState,
): VideoPokerView {
  const round = state.round;
  const seed = db
    .prepare('SELECT server_seed_hash FROM seed_pairs WHERE id = ?')
    .get(row.seed_pair_id) as { server_seed_hash: string };

  return {
    phase: round.phase,
    cards: [...round.cards],
    held: [...round.held],
    coins: round.coins,
    coinValue: round.coinValue,
    bet: videopoker.betFor(round.coins, round.coinValue),
    drawn: [...round.drawn],
    result: round.result,
    resultName: round.result ? videopoker.HAND_NAMES[round.result] : null,
    payout: round.payout,
    balance: getBalance(db, userId),
    proof: { serverSeedHash: seed.server_seed_hash, nonce: row.nonce },
  };
}

export function dealVideoPoker(
  db: Db,
  userId: string,
  coins: number,
  coinValue: number,
): VideoPokerView {
  if (openSession(db, userId, 'videopoker')) {
    throw new SessionConflictError('finish the hand in progress first');
  }
  const bet = videopoker.betFor(coins, coinValue);
  assertValidBet(bet, getBalance(db, userId));

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const state: VideoPokerState = { round: videopoker.deal(coins, coinValue, stream) };
  const id = randomUUID();
  const now = Date.now();

  applyLedger(db, userId, [{ delta: -bet, reason: 'wager' }]);
  db.prepare(
    `INSERT INTO game_sessions (id, user_id, game, state_json, seed_pair_id, nonce,
                                staked, started_at, updated_at)
     VALUES (?, ?, 'videopoker', ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, JSON.stringify(state), seedPairId, nonce, bet, now, now);

  return videoPokerView(
    db, userId,
    { id, game: 'videopoker', state_json: '', seed_pair_id: seedPairId, nonce, staked: bet, started_at: now },
    state,
  );
}

export function holdVideoPoker(db: Db, userId: string, held: boolean[]): VideoPokerView {
  const row = openSession(db, userId, 'videopoker');
  if (!row) throw new NoSuchSessionError('videopoker');
  const state = JSON.parse(row.state_json) as VideoPokerState;
  state.round = videopoker.setHolds(state.round, held);
  saveState(db, row.id, state);
  return videoPokerView(db, userId, row, state);
}

export function drawVideoPoker(db: Db, userId: string, held: boolean[]): VideoPokerView {
  const row = openSession(db, userId, 'videopoker');
  if (!row) throw new NoSuchSessionError('videopoker');
  const state = JSON.parse(row.state_json) as VideoPokerState;

  // The holds arrive with the draw, so a dropped "set holds" call cannot silently
  // discard cards the player meant to keep.
  state.round = videopoker.drawCards(videopoker.setHolds(state.round, held));
  saveState(db, row.id, state);

  if (state.round.payout > 0) {
    applyLedger(db, userId, [{ delta: state.round.payout, reason: 'payout' }]);
  }
  recordRound(
    db, userId, 'videopoker', row, row.staked, state.round.payout,
    { coins: state.round.coins, coinValue: state.round.coinValue },
    { cards: state.round.cards, held: state.round.held, result: state.round.result },
  );
  closeSession(db, row.id);
  return videoPokerView(db, userId, row, state);
}

export function videoPokerStatus(db: Db, userId: string): VideoPokerView | null {
  const row = openSession(db, userId, 'videopoker');
  if (!row) return null;
  return videoPokerView(db, userId, row, JSON.parse(row.state_json) as VideoPokerState);
}

// --------------------------------------------------------------------- hold'em --

interface HoldemState {
  table: holdem.HoldemTable;
  /** The seat the account is sitting in. Always 0 for now; explicit for the future. */
  you: number;
  /** Chips bought in with, so leaving can only ever return what was debited. */
  buyIn: number;
  /** Casual RNG seed for the bots - never the fair stream. */
  botSeed: number;
}

export const HOLDEM_BOTS = 3;
export const HOLDEM_BOT_STACK = 2_000;

/**
 * Bots' hole cards are absent from the payload until they are shown at a showdown.
 *
 * That is the whole game. Sending them and asking the UI not to look would let anyone
 * with the network tab open play perfectly, so the redaction lives here rather than in
 * the client.
 */
function holdemView(db: Db, userId: string, row: SessionRow, state: HoldemState): HoldemView {
  const t = state.table;
  const seed = db
    .prepare('SELECT server_seed_hash FROM seed_pairs WHERE id = ?')
    .get(row.seed_pair_id) as { server_seed_hash: string };

  const showdown = t.result?.wentToShowdown === true;
  const descriptions = new Map(
    (t.result?.entries ?? []).map((e) => [e.seat, e.description]),
  );

  const seats: HoldemSeatView[] = t.players.map((p) => {
    const reveal = p.seat === state.you || (showdown && holdem.inHand(p));
    return {
      seat: p.seat,
      name: p.name,
      chips: p.chips,
      isBot: p.isBot,
      style: p.profile?.name ?? null,
      ...(reveal && p.hole.length > 0 ? { hole: [...p.hole] } : {}),
      bet: p.bet,
      committed: p.committed,
      folded: p.folded,
      allIn: p.allIn,
      sittingOut: p.sittingOut,
      lastAction: p.lastAction,
      wonLast: p.wonLast,
      isButton: p.seat === t.button,
      isTurn: t.toAct === p.seat,
      ...(showdown ? { handDescription: descriptions.get(p.seat) ?? null } : {}),
    };
  });

  const you = t.players[state.you] as holdem.HoldemPlayer;
  const yourTurn = t.toAct === state.you && !holdem.isHandOver(t);

  return {
    street: t.street,
    board: [...t.board],
    pot: holdem.potOf(t),
    currentBet: t.currentBet,
    seats,
    you: state.you,
    toAct: t.toAct,
    yourTurn,
    actions: yourTurn ? holdem.legalActions(t, you) : [],
    toCall: holdem.toCall(t, you),
    minRaiseTo: holdem.minRaiseTo(t, you),
    maxRaiseTo: holdem.maxRaiseTo(t, you),
    handInProgress: t.handInProgress,
    handNumber: t.handNumber,
    log: [...t.log],
    result: t.result
      ? {
          wentToShowdown: t.result.wentToShowdown,
          winners: t.result.winners,
          pots: t.result.pots,
          rake: t.result.rake,
        }
      : null,
    balance: getBalance(db, userId),
    proof: { serverSeedHash: seed.server_seed_hash, nonce: row.nonce },
  };
}

/**
 * Let the bots act until it is the human's turn again, or the hand ends.
 *
 * Bounded rather than `while (true)`: a bug that stopped advancing the table would
 * otherwise hang the request thread rather than fail.
 */
function runBots(state: HoldemState): void {
  const random = createCasualSource(state.botSeed);
  // Advance the seed so the next request's bots do not replay the same decisions.
  state.botSeed = (state.botSeed * 1_103_515_245 + 12_345) >>> 0;

  for (let guard = 0; guard < 200; guard += 1) {
    const t = state.table;
    if (holdem.isHandOver(t) || t.toAct === null || t.toAct === state.you) return;
    holdem.playBotTurn(t, random);
  }
  throw new Error("hold'em table failed to settle");
}

function openHoldem(db: Db, userId: string): { row: SessionRow; state: HoldemState } {
  const row = openSession(db, userId, 'holdem');
  if (!row) throw new NoSuchSessionError('holdem');
  return { row, state: JSON.parse(row.state_json) as HoldemState };
}

export function sitHoldem(db: Db, userId: string, buyIn: number): HoldemView {
  if (openSession(db, userId, 'holdem')) {
    throw new SessionConflictError('you are already sitting at a table');
  }
  assertValidBet(buyIn, getBalance(db, userId));

  const { stream, seedPairId, nonce } = takeStream(db, userId);
  const botSeed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const players = holdem.makeTable(
    createCasualSource(botSeed), buyIn, HOLDEM_BOTS, HOLDEM_BOT_STACK,
  );
  const state: HoldemState = {
    table: holdem.createTable(players),
    you: 0,
    buyIn,
    botSeed,
  };
  // The shuffle for the first hand comes off the fair stream taken above.
  holdem.dealHand(state.table, stream);
  runBots(state);

  const id = randomUUID();
  const now = Date.now();
  applyLedger(db, userId, [{ delta: -buyIn, reason: 'wager' }]);
  db.prepare(
    `INSERT INTO game_sessions (id, user_id, game, state_json, seed_pair_id, nonce,
                                staked, started_at, updated_at)
     VALUES (?, ?, 'holdem', ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, JSON.stringify(state), seedPairId, nonce, buyIn, now, now);

  return holdemView(
    db, userId,
    { id, game: 'holdem', state_json: '', seed_pair_id: seedPairId, nonce, staked: buyIn, started_at: now },
    state,
  );
}

export function actHoldem(
  db: Db,
  userId: string,
  action: holdem.HoldemAction,
  amount: number,
): HoldemView {
  const { row, state } = openHoldem(db, userId);
  if (state.table.toAct !== state.you) throw new SessionConflictError('it is not your turn');

  holdem.act(state.table, action, amount);
  runBots(state);
  saveState(db, row.id, state);
  return holdemView(db, userId, row, state);
}

export function dealHoldem(db: Db, userId: string): HoldemView {
  const { row, state } = openHoldem(db, userId);
  if (state.table.handInProgress) throw new SessionConflictError('finish the hand first');
  if ((state.table.players[state.you] as holdem.HoldemPlayer).chips <= 0) {
    throw new SessionConflictError('you are out of chips at this table');
  }

  // A new hand is a new shuffle, so it takes a new nonce - and that is what makes each
  // hand independently verifiable rather than one long stream nobody can check.
  const { stream, seedPairId, nonce } = takeStream(db, userId);
  holdem.dealHand(state.table, stream);
  runBots(state);

  db.prepare('UPDATE game_sessions SET seed_pair_id = ?, nonce = ?, state_json = ?, updated_at = ? WHERE id = ?')
    .run(seedPairId, nonce, JSON.stringify(state), Date.now(), row.id);

  return holdemView(
    db, userId, { ...row, seed_pair_id: seedPairId, nonce }, state,
  );
}

/**
 * Stand up and take the stack home.
 *
 * The credit is the seat's *current* chips, and the debit happened at `sit`. pysino
 * refunded a buy-in that had never been debited, minting 4,918 chips; keeping both
 * halves in this file, one at each end of the session, is what stops that.
 */
export function leaveHoldem(db: Db, userId: string): { balance: number; cashedOut: number } {
  const { row, state } = openHoldem(db, userId);
  if (state.table.handInProgress) {
    throw new SessionConflictError('finish the hand before you stand up');
  }

  const stack = (state.table.players[state.you] as holdem.HoldemPlayer).chips;
  if (stack > 0) applyLedger(db, userId, [{ delta: stack, reason: 'payout' }]);

  recordRound(
    db, userId, 'holdem', row, state.buyIn, stack,
    { buyIn: state.buyIn, bots: HOLDEM_BOTS },
    { hands: state.table.handNumber, cashedOut: stack },
  );
  closeSession(db, row.id);
  return { balance: getBalance(db, userId), cashedOut: stack };
}

export function holdemStatus(db: Db, userId: string): HoldemView | null {
  const row = openSession(db, userId, 'holdem');
  if (!row) return null;
  return holdemView(db, userId, row, JSON.parse(row.state_json) as HoldemState);
}
