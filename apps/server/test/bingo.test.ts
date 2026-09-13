/**
 * The bingo hall.
 *
 * The clock is driven by hand, as it is for the tables: a round is forty seconds of wall
 * time and a test that sleeps through one is a test that goes flaky on a loaded runner.
 *
 * Two things are being defended here, and they are not the paytable - that is the engine's
 * test, and it is exact. They are:
 *
 *   **Chips.** A stake leaves a wallet at the buy and comes back, or does not, from the
 *   tick - minutes later, possibly after a restart. Every round must therefore satisfy
 *   `staked == returned + houseNet`, and the ledger must agree with the wallets after
 *   every one of them.
 *
 *   **The secret.** How many balls a round will actually call is its outcome in one
 *   number, because the draw stops once every card is settled. It must not be derivable
 *   from anything a client is sent - including the deadline, which is broadcast.
 */

import { STARTING_CHIPS, bingo } from '@websino/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../src/auth/index.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { auditBalances, getBalance } from '../src/db/ledger.js';
import { buildServer } from '../src/index.js';
import {
  BALL_MS, BUY_MS, MAX_STAKE, MIN_BALLS_CALLED, RESULTS_MS, type BingoHall,
} from '../src/rooms/bingo.js';

process.env.WEBSINO_NO_TICK = '1';

const HALL = 'bingo-hall';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
let hall: BingoHall;

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildServer(db);
  hall = (app as unknown as { bingoHall: BingoHall }).bingoHall;
});

afterEach(async () => {
  await app.close();
  db.close();
});

interface Player {
  id: string;
  username: string;
}

const signUp = async (username: string): Promise<Player> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'correct-horse-battery' },
  });
  const cookie = `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''}`;
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { id: me.json().user.id, username };
};

/** Advance the clock in slices, ticking each one, as the real interval would. */
const run = (from: number, ms: number, step = 250): number => {
  let now = from;
  const stop = from + ms;
  while (now < stop) {
    now = Math.min(now + step, stop);
    hall.tick(now);
  }
  return now;
};

/**
 * Tick until the hall reaches a phase, and answer with the clock at that moment.
 *
 * Not a fixed number of milliseconds, deliberately: the draw stops as soon as every card
 * is settled, so a round is between five and eighteen seconds long and *which* is the
 * outcome of a fair draw. Waiting a hardcoded interval and asserting the phase is a test
 * that passes on most seeds and fails on the rest - which is how this file's first draft
 * behaved.
 */
const until = (from: number, phase: 'buying' | 'drawing' | 'results'): number => {
  let now = from;
  const stop = from + 5 * (BUY_MS + bingo.BALLS_DRAWN * BALL_MS + RESULTS_MS);
  while (now < stop) {
    now += 250;
    hall.tick(now);
    if (hall.get(HALL).phase === phase) return now;
  }
  throw new Error(`the hall never reached ${phase}`);
};

/** Run a whole round: from a buy window, through the draw, to the next window. */
const wholeRound = (from: number): number => until(until(from, 'results'), 'buying');

// ------------------------------------------------------------------ buying in --

describe('buying into a round', () => {
  it('debits the stake and deals the cards at once', async () => {
    const ada = await signUp('ada');
    const view = hall.buy(ada.id, ada.username, HALL, 3, 50);

    expect(view.cards).toHaveLength(3);
    expect(view.yourStake).toBe(150);
    expect(getBalance(db, ada.id)).toBe(STARTING_CHIPS - 150);
    expect(auditBalances(db)).toEqual([]);

    // Dealt, and dealt properly: the whole card is there before a ball is called.
    for (const card of view.cards) {
      const numbers = card.numbers.flat().filter((v): v is number => v !== null);
      expect(numbers).toHaveLength(24);
      expect(card.marked).toEqual([]);
      expect(card.completedOn).toBeNull();
    }
  });

  it('gives each player different cards', async () => {
    const ada = await signUp('ada');
    const bob = await signUp('bob');
    const first = hall.buy(ada.id, ada.username, HALL, 1, 10);
    const second = hall.buy(bob.id, bob.username, HALL, 1, 10);
    expect(first.cards[0]?.numbers).not.toEqual(second.cards[0]?.numbers);
  });

  it('refuses a second buy in the same round', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 1, 10);
    expect(() => hall.buy(ada.id, ada.username, HALL, 1, 10)).toThrow(/already bought/);
    expect(getBalance(db, ada.id)).toBe(STARTING_CHIPS - 10);
  });

  it('refuses an illegal card count or stake', async () => {
    const ada = await signUp('ada');
    expect(() => hall.buy(ada.id, ada.username, HALL, 0, 10)).toThrow(/cards/);
    expect(() => hall.buy(ada.id, ada.username, HALL, 5, 10)).toThrow(/cards/);
    expect(() => hall.buy(ada.id, ada.username, HALL, 1, 0)).toThrow(/stake/);
    expect(() => hall.buy(ada.id, ada.username, HALL, 1, MAX_STAKE + 1)).toThrow(/stake/);
    expect(() => hall.buy(ada.id, ada.username, HALL, 1, 1.5)).toThrow(/stake/);
    // Nothing moved on any of them.
    expect(getBalance(db, ada.id)).toBe(STARTING_CHIPS);
  });

  it('refuses a stake the player cannot cover', async () => {
    const ada = await signUp('ada');
    expect(() => hall.buy(ada.id, ada.username, HALL, 4, MAX_STAKE)).toThrow(/enough chips/);
    expect(getBalance(db, ada.id)).toBe(STARTING_CHIPS);
  });

  it('refuses a buy once the balls are rolling', async () => {
    const ada = await signUp('ada');
    const bob = await signUp('bob');
    hall.buy(ada.id, ada.username, HALL, 1, 10);

    until(Date.now(), 'drawing');
    expect(() => hall.buy(bob.id, bob.username, HALL, 1, 10)).toThrow(/already started/);
    expect(getBalance(db, bob.id)).toBe(STARTING_CHIPS);
  });
});

// -------------------------------------------------------------------- the loop --

describe('the round loop', () => {
  it('does not draw to an empty hall, and re-arms the window instead', () => {
    const start = Date.now();
    const before = hall.viewFor(HALL, null);
    expect(before.phase).toBe('buying');

    const now = run(start, BUY_MS * 2 + 1_000);
    const after = hall.viewFor(HALL, null);
    expect(after.phase).toBe('buying');
    // Same round: nothing was played, so nothing was counted.
    expect(after.round).toBe(before.round);
    expect(after.called).toEqual([]);
    expect(after.deadline).toBeGreaterThan(now);
  });

  it('runs buying to drawing to results and back to buying', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 2, 25);
    expect(hall.viewFor(HALL, ada.id).phase).toBe('buying');

    let now = until(Date.now(), 'drawing');
    expect(hall.viewFor(HALL, ada.id).called.length).toBeLessThan(bingo.BALLS_DRAWN);

    now = until(now, 'results');
    expect(hall.viewFor(HALL, ada.id).phase).toBe('results');

    now = until(now, 'buying');
    const next = hall.viewFor(HALL, ada.id);
    expect(next.phase).toBe('buying');
    expect(next.round).toBe(2);
    // A new round is a clean slate: last round's cards are not still on the screen.
    expect(next.cards).toEqual([]);
    expect(next.called).toEqual([]);
    expect(next.lastRound?.round).toBe(1);
  });

  it('reveals balls on the clock, one every BALL_MS', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 1, 10);

    until(Date.now(), 'drawing');
    // The instant the hall itself started from, not the instant the loop noticed: the
    // reveal is a function of that, and a test that guessed it would be off by a ball.
    const drawStart = hall.get(HALL).drawStartedAt as number;
    for (const balls of [1, 4, 9]) {
      const at = drawStart + balls * BALL_MS + 10;
      hall.tick(at);
      const view = hall.view(hall.get(HALL), ada.id, at);
      expect(view.called).toHaveLength(balls);
      // Called once each, in order, and never the same ball twice.
      expect(new Set(view.called).size).toBe(balls);
    }
  });

  it('marks a card as the balls that are on it come out', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 1, 10);
    until(Date.now(), 'drawing');
    const drawStart = hall.get(HALL).drawStartedAt as number;

    // Far enough in that some of the card is covered, but inside the shortest draw.
    const at = drawStart + (MIN_BALLS_CALLED - 1) * BALL_MS + 10;
    hall.tick(at);
    const view = hall.view(hall.get(HALL), ada.id, at);
    const card = view.cards[0];
    if (!card) throw new Error('no card');

    const called = new Set(view.called);
    for (const [row, column] of card.marked) {
      expect(called.has(card.numbers[row]?.[column] as number)).toBe(true);
    }
    // The "one away" count is the closest line's remainder, so it can only fall.
    expect(card.toGo).toBeGreaterThanOrEqual(0);
    expect(card.toGo).toBeLessThanOrEqual(5);
  });

  it('calls at least MIN_BALLS_CALLED balls however fast the round is decided', async () => {
    // A round decided on ball six would otherwise last two seconds and read as a glitch.
    const ada = await signUp('ada');
    let now = Date.now();
    for (let round = 0; round < 6; round += 1) {
      hall.buy(ada.id, ada.username, HALL, 1, 1);
      now = until(now, 'results');
      const view = hall.view(hall.get(HALL), ada.id, now);
      expect(view.called.length).toBeGreaterThanOrEqual(MIN_BALLS_CALLED);
      expect(view.called.length).toBeLessThanOrEqual(bingo.BALLS_DRAWN);
      now = until(now, 'buying');
    }
  });
});

// ------------------------------------------------------------------- the money --

describe('chips', () => {
  /**
   * The conservation law for a hall.
   *
   * There is no felt here and no pot: a stake is debited at the buy and settled from the
   * tick, so what has to balance is the round itself. Every chip staked either came back
   * to a player or stayed with the house, and `houseNet` is the only place the difference
   * may go.
   */
  it('settles every round to exactly staked = returned + house', async () => {
    const ada = await signUp('ada');
    const bob = await signUp('bob');
    let now = Date.now();

    for (let round = 0; round < 5; round += 1) {
      const before = getBalance(db, ada.id) + getBalance(db, bob.id);
      const houseBefore = hall.houseNet(HALL);

      hall.buy(ada.id, ada.username, HALL, 2, 20);
      hall.buy(bob.id, bob.username, HALL, 3, 10);
      const staked = 2 * 20 + 3 * 10;

      now = wholeRound(now);

      const after = getBalance(db, ada.id) + getBalance(db, bob.id);
      const returned = after - (before - staked);
      expect(returned).toBeGreaterThanOrEqual(0);
      expect(staked).toBe(returned + (hall.houseNet(HALL) - houseBefore));
      expect(auditBalances(db)).toEqual([]);
    }
  });

  it('pays what the card view said it would', async () => {
    const ada = await signUp('ada');
    const start = getBalance(db, ada.id);
    hall.buy(ada.id, ada.username, HALL, 4, 50);

    // Read the settled view before the results window closes, then check the wallet.
    let now = until(Date.now(), 'results');
    const settled = hall.view(hall.get(HALL), ada.id, now);

    const expected = settled.cards.reduce((sum, card) => sum + card.payout, 0);
    expect(settled.yourPayout).toBe(expected);
    expect(getBalance(db, ada.id)).toBe(start - 200 + expected);

    now = until(now, 'buying');
    expect(auditBalances(db)).toEqual([]);
  });

  it('writes one wager row and one round record per player per round', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 2, 30);
    wholeRound(Date.now());

    const wagers = db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ? AND reason = 'wager'")
      .get(ada.id) as { n: number };
    expect(wagers.n).toBe(1);

    const rounds = db
      .prepare("SELECT bet, payout FROM rounds WHERE user_id = ? AND game = 'bingo'")
      .all(ada.id) as Array<{ bet: number; payout: number }>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.bet).toBe(60);

    const entry = db
      .prepare('SELECT payout FROM bingo_entries WHERE room_id = ? AND round = 1 AND user_id = ?')
      .get(HALL, ada.id) as { payout: number | null };
    // Settled: a NULL here is a stake nobody will ever answer for.
    expect(entry.payout).not.toBeNull();
    expect(entry.payout).toBe(rounds[0]?.payout);
  });

  it('pays a player who walked away from the screen', async () => {
    // Settlement is the tick's job, not a socket's, so a disconnect cannot cost a card.
    const ada = await signUp('ada');
    const start = getBalance(db, ada.id);
    hall.buy(ada.id, ada.username, HALL, 4, 100);
    wholeRound(Date.now());

    const entry = db
      .prepare('SELECT staked, payout FROM bingo_entries WHERE room_id = ? AND round = 1 AND user_id = ?')
      .get(HALL, ada.id) as { staked: number; payout: number };
    expect(getBalance(db, ada.id)).toBe(start - entry.staked + entry.payout);
    expect(auditBalances(db)).toEqual([]);
  });

  /**
   * The one way a restart can strand chips.
   *
   * The snapshot is what says which round is live, so an unsettled stake the live round
   * has never heard of is a stake that will never be paid or lost. A hall refunds those
   * when it starts, and this drives the repair directly by planting the row.
   */
  it('refunds a stake stranded by a lost snapshot', async () => {
    const ada = await signUp('ada');
    const before = getBalance(db, ada.id);

    db.prepare(
      `INSERT INTO bingo_entries (room_id, round, user_id, cards, stake, staked, bought_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(HALL, 999, ada.id, 2, 100, 200, Date.now());
    // The chips really did leave, or there would be nothing to give back.
    db.prepare('UPDATE wallets SET chips = chips - 200 WHERE user_id = ?').run(ada.id);
    db.prepare(
      `INSERT INTO ledger (user_id, delta, balance_after, reason, created_at)
       VALUES (?, -200, ?, 'wager', ?)`,
    ).run(ada.id, before - 200, Date.now());

    // A fresh hall over the same database is what a restart looks like.
    const restarted = await buildServer(db);
    try {
      expect(getBalance(db, ada.id)).toBe(before);
      expect(auditBalances(db)).toEqual([]);
    } finally {
      await restarted.close();
    }
  });
});

// ------------------------------------------------------------------ redaction --

describe('what a client is told', () => {
  it('sends only the balls already called', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 1, 10);
    until(Date.now(), 'drawing');
    const drawStart = hall.get(HALL).drawStartedAt as number;

    const at = drawStart + 10 * BALL_MS + 10;
    hall.tick(at);
    const view = hall.view(hall.get(HALL), ada.id, at);
    expect(view.called).toHaveLength(10);

    // The rest of the sequence is not in the payload under any name.
    const state = hall.get(HALL);
    const upcoming = state.balls.slice(10, state.ballsToCall);
    const wire = JSON.stringify(view);
    const leaked = upcoming.filter((ball) => !view.called.includes(ball)
      && !JSON.stringify(view.cards).includes(String(ball)));
    // A ball can legitimately appear as a number printed on the player's own card, so
    // what is checked is that no *uncalled* ball reaches the wire except as card ink.
    for (const ball of leaked) {
      expect(wire.includes(`,${ball},`)).toBe(false);
    }
  });

  /**
   * The round's length is its outcome, so the deadline must not give it away.
   *
   * The draw ends as soon as every card is settled, which means "how many balls will this
   * round call" is the same information as "which band does my card land in". The deadline
   * is broadcast so every client counts to the same instant - making it the one field that
   * could be subtracted to recover the secret. It therefore advertises the full fifty.
   */
  it('never lets the deadline reveal how long the draw really is', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 1, 10);
    until(Date.now(), 'drawing');

    const state = hall.get(HALL);
    const drawStart = state.drawStartedAt as number;
    const view = hall.view(state, ada.id, drawStart);
    expect(view.deadline - drawStart).toBeGreaterThanOrEqual(
      (bingo.BALLS_DRAWN - 1) * BALL_MS,
    );
    // Only true of a round that stops early - which is most of them.
    if (state.ballsToCall < bingo.BALLS_DRAWN) {
      expect(view.deadline - drawStart).toBeGreaterThan(state.ballsToCall * BALL_MS);
    }
    expect(JSON.stringify(view)).not.toContain('ballsToCall');
  });

  it('does not send other players\' cards', async () => {
    const ada = await signUp('ada');
    const bob = await signUp('bob');
    hall.buy(ada.id, ada.username, HALL, 1, 10);
    const bobsView = hall.buy(bob.id, bob.username, HALL, 2, 10);

    const adasView = hall.viewFor(HALL, ada.id);
    expect(adasView.cards).toHaveLength(1);
    expect(bobsView.cards).toHaveLength(2);
    expect(adasView.players).toBe(2);

    // Ada's payload contains no square of Bob's, and Bob's none of Ada's.
    const bobsNumbers = bobsView.cards.flatMap((c) => c.numbers.flat());
    const adasCard = JSON.stringify(adasView.cards);
    expect(bobsNumbers.length).toBeGreaterThan(0);
    expect(adasCard).not.toContain(JSON.stringify(bobsView.cards[0]?.numbers));
  });

  it('shows a watcher the room without giving them cards', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 2, 10);

    const watcher = hall.viewFor(HALL, null);
    expect(watcher.cards).toEqual([]);
    expect(watcher.yourStake).toBe(0);
    expect(watcher.canBuy).toBe(false);
    // They can still see a round is running and how big it is.
    expect(watcher.players).toBe(1);
    expect(watcher.staked).toBe(20);
  });

  it('quotes the exact paytable it is playing to', () => {
    const view = hall.viewFor(HALL, null);
    const odds = bingo.exactOdds();
    expect(view.tiers).toHaveLength(bingo.TIERS.length);
    view.tiers.forEach((tier, index) => {
      expect(tier.multiplier).toBe(bingo.TIERS[index]?.multiplier);
      expect(tier.chance).toBe(odds.byTier[index]);
    });
    expect(view.ballsDrawn).toBe(bingo.BALLS_DRAWN);
    expect(view.ballMs).toBe(BALL_MS);
  });

  it('lists the hall for the lobby', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bingo' });
    expect(response.statusCode).toBe(200);
    const halls = response.json().halls as Array<{ id: string; phase: string }>;
    expect(halls.map((h) => h.id)).toContain(HALL);
    expect(halls[0]?.phase).toBe('buying');
  });
});

// --------------------------------------------------------------- announcements --

describe('the log', () => {
  it('says when a card comes in, once each', async () => {
    const ada = await signUp('ada');
    hall.buy(ada.id, ada.username, HALL, 4, 10);
    const now = until(Date.now(), 'results');

    const view = hall.view(hall.get(HALL), ada.id, now);
    const completed = view.cards.filter((card) => card.completedOn !== null).length;
    const lines = hall.get(HALL).log.filter((line) => line.includes('came in on ball'));
    expect(lines).toHaveLength(completed);

    // Keep ticking: an announcement must not be repeated on every tick that follows.
    run(now, RESULTS_MS - 500);
    expect(hall.get(HALL).log.filter((l) => l.includes('came in on ball'))).toHaveLength(
      completed,
    );
  });

  it('keeps the log bounded so the snapshot cannot grow forever', async () => {
    const ada = await signUp('ada');
    let now = Date.now();
    for (let round = 0; round < 8; round += 1) {
      hall.buy(ada.id, ada.username, HALL, 1, 1);
      now = wholeRound(now);
    }
    expect(hall.get(HALL).log.length).toBeLessThanOrEqual(40);
    expect(hall.viewFor(HALL, ada.id).log.length).toBeLessThanOrEqual(12);
  });
});
