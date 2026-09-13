/**
 * The bingo hall: one ball sequence, everybody watching it, each card paid on its own.
 *
 * Structurally this is the other kind of shared room. A hold'em table is shared because
 * players *act against each other* - hence seats, a turn clock, a pot and bots to fill the
 * felt. A bingo round is shared only because everyone is watching the same balls: there is
 * nothing to take turns over, no seat to own, and nobody to play against, so none of that
 * machinery appears here. What it keeps from the table code is the one thing both need -
 * a room that advances on a tick whether or not anyone is looking, snapshotted after every
 * mutation because chips have already left wallets.
 *
 * A round is a three-phase loop:
 *
 *   buying   a window to buy 1-4 cards. Cards are dealt at once, off the buyer's own fair
 *            stream, so you can look at them while you wait.
 *   drawing  the sequence is drawn once, from the first buyer's stream, and revealed a
 *            ball at a time.
 *   results  a pause to read the room before the next window opens.
 *
 * **The reveal is a function of the clock, not of the tick.** `drawStartedAt` plus
 * `BALL_MS` says how many balls are showing, so a tick that runs late, twice, or not at
 * all cannot desync the hall from what players have already seen - and the client can
 * animate ahead of the next push instead of waiting for it.
 *
 * **No bots.** They would be pure decoration: a card pays what the paytable says whether
 * one person is in the round or twenty, so filling the hall with fake players would add
 * names to a list and nothing else. The deliberate cost is that a quiet hall looks quiet,
 * which is honest.
 */

import { randomUUID } from 'node:crypto';

import {
  assertValidBet, bingo, MIN_BET, type BingoCardView, type BingoSummary, type BingoView,
} from '@websino/engine';

import type { Db } from '../db/index.js';
import { applyLedger, getBalance } from '../db/ledger.js';
import { takeStream } from '../fair/seeds.js';

export class BingoRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BingoRoomError';
  }
}

/** How long the buy window stays open. Long enough for somebody else to arrive. */
export const BUY_MS = 15_000;
/** Time between balls. */
export const BALL_MS = 350;
/** How long results stay up before the next window opens. */
export const RESULTS_MS = 7_000;
/**
 * The shortest draw, however fast the round is decided.
 *
 * A round where every card came in by ball six would otherwise last two seconds, which
 * reads as a glitch rather than a win. It also blunts the one thing the early stop gives
 * away: with a floor, a draw ending at fifteen no longer means a card completed on the
 * fifteenth ball.
 */
export const MIN_BALLS_CALLED = 15;

export const MIN_STAKE = MIN_BET;
/**
 * Per card, not per round.
 *
 * Well under the engine's global `MAX_BET` on purpose: four cards at the cap is a 40,000
 * round, and the top tier pays ten times, so this is the number that bounds what one
 * player can take out of a single round.
 */
export const MAX_STAKE = 10_000;

const HALL = { id: 'bingo-hall', name: 'The Bingo Hall' } as const;

interface Entry {
  userId: string;
  username: string;
  /** Stake per card. */
  stake: number;
  staked: number;
  cards: bingo.BingoCard[];
  seedPairId: string;
  nonce: number;
}

export interface HallState {
  id: string;
  name: string;
  phase: 'buying' | 'drawing' | 'results';
  round: number;
  /** Epoch ms the current phase ends. */
  deadline: number;
  entries: Entry[];
  /** The whole sequence for this round. Only ever sent as a prefix. */
  balls: number[];
  drawStartedAt: number | null;
  /**
   * How many balls this round actually calls.
   *
   * The round's outcome compressed into one number, and therefore a secret: it is the
   * last ball that settles anything, so publishing it during the draw would tell every
   * player the band their own card lands in before a single ball had come out. It never
   * reaches a view.
   */
  ballsToCall: number;
  /** `userId:cardIndex` for every completion already in the log, so each is said once. */
  announced: string[];
  /** The house's net across every round this hall has run. Can be negative. */
  houseNet: number;
  lastRound: BingoView['lastRound'];
  log: string[];
}

// ------------------------------------------------------------------ pure helpers --

const createHall = (id: string, name: string): HallState => ({
  id,
  name,
  phase: 'buying',
  round: 1,
  deadline: Date.now() + BUY_MS,
  entries: [],
  balls: [],
  drawStartedAt: null,
  ballsToCall: 0,
  announced: [],
  houseNet: 0,
  lastRound: null,
  log: [],
});

/** How many balls are showing right now. Derived from the clock, never counted up. */
export function revealedCount(state: HallState, now: number): number {
  if (state.phase === 'results') return state.ballsToCall;
  if (state.phase !== 'drawing' || state.drawStartedAt === null) return 0;
  const due = Math.floor((now - state.drawStartedAt) / BALL_MS);
  return Math.max(0, Math.min(due, state.ballsToCall));
}

const calledBalls = (state: HallState, now: number): number[] =>
  state.balls.slice(0, revealedCount(state, now));

/**
 * Mark a card against the balls called so far.
 *
 * `toGo` is the closest line's remaining count - the "one away" that makes the last few
 * balls worth watching. Derived here rather than on the client because the client would
 * need the line geometry to compute it, and geometry is the engine's business.
 */
function cardView(
  card: bingo.BingoCard,
  called: readonly number[],
  stake: number,
): BingoCardView {
  const seen = new Set(called);
  const marked: Array<[number, number]> = [];
  for (let row = 0; row < bingo.CARD_SIZE; row += 1) {
    for (let column = 0; column < bingo.CARD_SIZE; column += 1) {
      const value = bingo.cellAt(card, row, column);
      if (value !== null && seen.has(value)) marked.push([row, column]);
    }
  }

  let toGo = bingo.CARD_SIZE;
  for (const line of bingo.LINES) {
    let missing = 0;
    for (const [row, column] of line) {
      const value = bingo.cellAt(card, row, column);
      if (value !== null && !seen.has(value)) missing += 1;
    }
    toGo = Math.min(toGo, missing);
  }

  const result = bingo.settleCard(card, called);
  return {
    numbers: card.map((row) => [...row]),
    marked,
    toGo,
    completedOn: result.ball,
    line: result.line.map(([row, column]) => [row, column] as [number, number]),
    multiplier: result.multiplier,
    payout: bingo.payoutForCard(stake, result),
  };
}

// ------------------------------------------------------------------- the hall --

export class BingoHall {
  readonly #db: Db;
  readonly #halls = new Map<string, HallState>();
  #onChange: (roomId: string) => void = () => {};
  #timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Balls already pushed, per hall. In memory on purpose: it decides whether to *notify*,
   * and the persisted snapshot already implies it, so writing it would mean a database
   * round-trip per ball to store a number that can be recomputed.
   */
  readonly #pushedBalls = new Map<string, number>();

  constructor(db: Db) {
    this.#db = db;
    this.#restore();
  }

  onChange(listener: (roomId: string) => void): void {
    this.#onChange = listener;
  }

  // ------------------------------------------------------------ persistence --

  #restore(): void {
    const rows = this.#db
      .prepare("SELECT state_json FROM rooms WHERE game = 'bingo'")
      .all() as Array<{ state_json: string }>;
    for (const row of rows) {
      const state = JSON.parse(row.state_json) as HallState;
      this.#halls.set(state.id, state);
    }

    if (!this.#halls.has(HALL.id)) {
      const hall = createHall(HALL.id, HALL.name);
      this.#halls.set(hall.id, hall);
      this.#save(hall);
    }

    for (const state of this.#halls.values()) this.#refundStranded(state);
  }

  /**
   * Give back chips staked on a round the hall can no longer settle.
   *
   * The snapshot is the source of truth for what is live, so an unsettled row the live
   * round does not know about is a stake that will never be paid or lost - the only way a
   * restart can strand chips here. Refunding it is the honest repair, and it is a no-op
   * in every normal restart.
   */
  #refundStranded(state: HallState): void {
    const live = new Set(state.entries.map((entry) => `${state.round}:${entry.userId}`));
    const rows = this.#db
      .prepare(
        'SELECT round, user_id AS userId, staked FROM bingo_entries WHERE room_id = ? AND payout IS NULL',
      )
      .all(state.id) as Array<{ round: number; userId: string; staked: number }>;

    for (const row of rows) {
      if (live.has(`${row.round}:${row.userId}`)) continue;
      this.#db.transaction(() => {
        applyLedger(this.#db, row.userId, [{ delta: row.staked, reason: 'adjustment' }]);
        this.#db
          .prepare('UPDATE bingo_entries SET payout = ? WHERE room_id = ? AND round = ? AND user_id = ?')
          .run(row.staked, state.id, row.round, row.userId);
      })();
    }
  }

  #save(state: HallState): void {
    // The log is trimmed on write rather than on read: it is persisted, so an untrimmed
    // one grows the snapshot forever.
    if (state.log.length > 40) state.log = state.log.slice(-40);
    this.#db
      .prepare(
        `INSERT INTO rooms (id, game, name, state_json, updated_at)
         VALUES (?, 'bingo', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(state.id, state.name, JSON.stringify(state), Date.now());
    this.#onChange(state.id);
  }

  // ----------------------------------------------------------------- access --

  get(roomId: string): HallState {
    const state = this.#halls.get(roomId);
    if (!state) throw new BingoRoomError(`no such bingo hall: ${roomId}`);
    return state;
  }

  list(): BingoSummary[] {
    return [...this.#halls.values()].map((state) => ({
      id: state.id,
      name: state.name,
      phase: state.phase,
      round: state.round,
      players: state.entries.length,
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
      maxCards: bingo.MAX_CARDS,
    }));
  }

  // -------------------------------------------------------------- buying in --

  /**
   * Buy into the current round.
   *
   * One buy per player per round. Letting somebody add a card halfway through the window
   * would mean either a second stake to reconcile against the same round or a top-up path
   * that can double-debit under a race, and the alternative costs a player nothing but a
   * wait of a few seconds.
   */
  buy(
    userId: string,
    username: string,
    roomId: string,
    cards: number,
    stake: number,
  ): BingoView {
    const state = this.get(roomId);

    if (state.phase !== 'buying') {
      throw new BingoRoomError('this round has already started - you are in for the next one');
    }
    if (!Number.isInteger(cards) || cards < bingo.MIN_CARDS || cards > bingo.MAX_CARDS) {
      throw new BingoRoomError(`you may buy ${bingo.MIN_CARDS} to ${bingo.MAX_CARDS} cards`);
    }
    if (!Number.isInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
      throw new BingoRoomError(`the stake per card must be between ${MIN_STAKE} and ${MAX_STAKE}`);
    }
    if (state.entries.some((entry) => entry.userId === userId)) {
      throw new BingoRoomError('you have already bought into this round');
    }

    const staked = cards * stake;
    assertValidBet(staked, getBalance(this.#db, userId));

    // Dealt before the debit so the only thing a failed transaction costs is a nonce -
    // which is monotonic, so a gap in it is not a problem. Doing it the other way round
    // risks a debit with no cards to show for it.
    const { stream, seedPairId, nonce } = takeStream(this.#db, userId);
    const dealt = Array.from({ length: cards }, () => bingo.makeCard(stream));

    this.#db.transaction(() => {
      applyLedger(this.#db, userId, [{ delta: -staked, reason: 'wager' }]);
      this.#db
        .prepare(
          `INSERT INTO bingo_entries (room_id, round, user_id, cards, stake, staked, bought_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, state.round, userId, cards, stake, staked, Date.now());
    })();

    state.entries.push({ userId, username, stake, staked, cards: dealt, seedPairId, nonce });
    state.log.push(`${username} bought ${cards} card${cards === 1 ? '' : 's'} at ${stake}`);
    this.#save(state);
    return this.view(state, userId, Date.now());
  }

  // ------------------------------------------------------------------ tick --

  start(intervalMs = 250): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick(now = Date.now()): void {
    for (const state of this.#halls.values()) {
      switch (state.phase) {
        case 'buying':
          if (now < state.deadline) break;
          if (state.entries.length === 0) {
            // Nobody bought. Re-arm the window rather than drawing to an empty hall: no
            // nonce is spent on a round with no cards in it, and a watcher keeps a live
            // countdown instead of staring at a dead screen.
            state.deadline = now + BUY_MS;
            this.#save(state);
          } else {
            this.#beginDraw(state, now);
          }
          break;

        case 'drawing': {
          const revealed = revealedCount(state, now);
          const announced = this.#announce(state, now);
          if (revealed >= state.ballsToCall) {
            this.#settle(state, now);
          } else if (announced) {
            this.#save(state);
          } else if (this.#pushedBalls.get(state.id) !== revealed) {
            // A new ball, and nothing else changed: the snapshot already implies it, so
            // the clients are told without a write.
            this.#pushedBalls.set(state.id, revealed);
            this.#onChange(state.id);
          }
          break;
        }

        case 'results':
          if (now >= state.deadline) this.#nextRound(state, now);
          break;
      }
    }
  }

  /** Draw the sequence and work out how much of it needs calling. */
  #beginDraw(state: HallState, now: number): void {
    // The first buyer's stream, so the sequence is verifiable by somebody with a stake in
    // the round rather than by nobody - the same anchoring a shared hold'em shuffle uses.
    const anchor = state.entries[0] as Entry;
    const { stream } = takeStream(this.#db, anchor.userId);
    state.balls = bingo.drawBalls(stream);

    let last = MIN_BALLS_CALLED;
    for (const entry of state.entries) {
      for (const card of entry.cards) {
        const result = bingo.settleCard(card, state.balls);
        // A card that never comes in keeps the draw running to the end - there is no
        // point at which it is settled early.
        if (result.ball === null) {
          last = bingo.BALLS_DRAWN;
          break;
        }
        last = Math.max(last, result.ball);
      }
      if (last === bingo.BALLS_DRAWN) break;
    }
    state.ballsToCall = Math.min(last, bingo.BALLS_DRAWN);

    state.phase = 'drawing';
    state.drawStartedAt = now;
    /*
     * The *nominal* end - fifty balls - and not when the draw will actually stop.
     *
     * The deadline is broadcast so every client counts down to the same instant, which
     * makes it the one field that could give `ballsToCall` away: a client that knows both
     * the deadline and how many balls are showing can subtract. So it advertises the full
     * round and the phase simply ends early. Nothing in the tick reads it during a draw -
     * the draw ends on the ball count, not the clock.
     */
    state.deadline = now + bingo.BALLS_DRAWN * BALL_MS;
    state.announced = [];
    this.#pushedBalls.set(state.id, 0);
    state.log.push(
      `Round ${state.round}: eyes down, ${state.entries.length} player${
        state.entries.length === 1 ? '' : 's'
      } in`,
    );
    this.#save(state);
  }

  /** Say so when a card comes in. Returns whether anything was added to the log. */
  #announce(state: HallState, now: number): boolean {
    const called = calledBalls(state, now);
    if (called.length === 0) return false;
    const seen = new Set(state.announced);
    let added = false;

    for (const entry of state.entries) {
      for (let index = 0; index < entry.cards.length; index += 1) {
        const key = `${entry.userId}:${index}`;
        if (seen.has(key)) continue;
        const result = bingo.settleCard(entry.cards[index] as bingo.BingoCard, called);
        if (result.ball === null) continue;
        state.announced.push(key);
        state.log.push(
          `${entry.username}'s card came in on ball ${result.ball} for ${result.multiplier}x`,
        );
        added = true;
      }
    }
    return added;
  }

  /**
   * Pay every card and close the round.
   *
   * One transaction per player: their credit, their entry marked settled, and their audit
   * row, so a payout cannot exist without the stake it answers.
   */
  #settle(state: HallState, now: number): void {
    // The prefix that was actually called. Identical in effect to the full fifty - the
    // draw only stops early once no remaining ball could settle anything.
    const called = state.balls.slice(0, state.ballsToCall);
    let best = 0;
    let bestBall: number | null = null;
    let returned = 0;

    for (const entry of state.entries) {
      const results = entry.cards.map((card) => bingo.settleCard(card, called));
      const payout = results.reduce(
        (sum, result) => sum + bingo.payoutForCard(entry.stake, result),
        0,
      );
      returned += payout;

      for (const result of results) {
        if (result.multiplier > best) {
          best = result.multiplier;
          bestBall = result.ball;
        }
      }

      const roundId = randomUUID();
      this.#db.transaction(() => {
        if (payout > 0) {
          applyLedger(this.#db, entry.userId, [
            { delta: payout, reason: 'payout', roundId },
          ]);
        }
        this.#db
          .prepare(
            'UPDATE bingo_entries SET payout = ? WHERE room_id = ? AND round = ? AND user_id = ?',
          )
          .run(payout, state.id, state.round, entry.userId);
        this.#db
          .prepare(
            `INSERT INTO rounds (id, user_id, game, seed_pair_id, nonce, bet, payout,
                                 config_json, outcome_json, created_at)
             VALUES (?, ?, 'bingo', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            roundId, entry.userId, entry.seedPairId, entry.nonce, entry.staked, payout,
            JSON.stringify({ roomId: state.id, round: state.round, cards: entry.cards.length, stake: entry.stake }),
            JSON.stringify({
              // The sequence is recorded because it came off the anchor's stream, not
              // this player's: their own seed replays their cards, and nothing else.
              balls: called,
              anchor: (state.entries[0] as Entry).userId,
              results: results.map((result) => ({ ball: result.ball, multiplier: result.multiplier })),
            }),
            Date.now(),
          );
      })();
    }

    const staked = state.entries.reduce((sum, entry) => sum + entry.staked, 0);
    state.houseNet += staked - returned;
    state.lastRound = {
      round: state.round,
      players: state.entries.length,
      bestMultiplier: best,
      bestBall,
    };
    state.phase = 'results';
    state.deadline = now + RESULTS_MS;
    state.log.push(
      returned > 0
        ? `Round ${state.round} paid ${returned} on ${staked} staked`
        : `Round ${state.round}: no card came in`,
    );
    this.#save(state);
  }

  #nextRound(state: HallState, now: number): void {
    state.round += 1;
    state.phase = 'buying';
    state.deadline = now + BUY_MS;
    state.entries = [];
    state.balls = [];
    state.drawStartedAt = null;
    state.ballsToCall = 0;
    state.announced = [];
    this.#pushedBalls.delete(state.id);
    this.#save(state);
  }

  // ------------------------------------------------------------------ view --

  view(state: HallState, userId: string | null, now = Date.now()): BingoView {
    const called = calledBalls(state, now);
    const yours = userId === null ? undefined : state.entries.find((e) => e.userId === userId);
    const cards = yours
      ? yours.cards.map((card) => cardView(card, called, yours.stake))
      : [];

    const odds = bingo.exactOdds();

    return {
      id: state.id,
      name: state.name,
      phase: state.phase,
      round: state.round,
      deadline: state.deadline,
      called,
      ballsDrawn: bingo.BALLS_DRAWN,
      ballMs: BALL_MS,
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
      maxCards: bingo.MAX_CARDS,
      tiers: bingo.TIERS.map((tier, index) => ({
        upTo: tier.upTo,
        multiplier: tier.multiplier,
        chance: odds.byTier[index] as number,
      })),
      players: state.entries.length,
      staked: state.entries.reduce((sum, entry) => sum + entry.staked, 0),
      cards,
      yourStake: yours?.staked ?? 0,
      yourPayout: cards.reduce((sum, card) => sum + card.payout, 0),
      lastRound: state.lastRound,
      balance: userId === null ? 0 : getBalance(this.#db, userId),
      canBuy: userId !== null && state.phase === 'buying' && yours === undefined,
      log: state.log.slice(-12),
    };
  }

  viewFor(roomId: string, userId: string | null): BingoView {
    return this.view(this.get(roomId), userId);
  }

  /** The hall's net take, for the conservation test. */
  houseNet(roomId: string): number {
    return this.get(roomId).houseNet;
  }
}
