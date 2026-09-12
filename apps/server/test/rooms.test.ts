/**
 * Shared-table tests.
 *
 * The clock is driven **by hand** throughout - `app.rooms.tick(now)` with an explicit
 * instant - rather than by sleeping. A twenty-second turn timer and a sixty-second
 * disconnect grace are untestable in real time, and a test that sleeps for a second
 * "to be safe" is a test that goes flaky on a loaded CI runner.
 *
 * The invariant every one of these is really circling is chip conservation: a buy-in has
 * left a wallet, so the chips on the felt plus the chips in the wallet must equal what
 * the account started with, at every point, including after a timeout, a disconnect, or
 * a restart. `auditBalances` is asserted clean at the end of anything that moves chips.
 */

import { STARTING_CHIPS, holdem } from '@websino/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../src/auth/index.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { auditBalances, getBalance, recentLedger } from '../src/db/ledger.js';
import { buildServer } from '../src/index.js';
import type { RoomRegistry, RoomView } from '../src/rooms/registry.js';
import {
  DISCONNECT_GRACE_MS, MIN_BUY_IN, SEAT_COUNT, TARGET_PLAYERS, TURN_MS,
} from '../src/rooms/room.js';

// No background timer under the tests: every tick here is one we asked for.
process.env.WEBSINO_NO_TICK = '1';

const ROOM = 'table-lowball';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;
let rooms: RoomRegistry;

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildServer(db);
  rooms = (app as unknown as { rooms: RoomRegistry }).rooms;
});

afterEach(async () => {
  await app.close();
  db.close();
});

interface Player {
  id: string;
  username: string;
  cookie: string;
}

const signUp = async (username: string): Promise<Player> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'correct-horse-battery' },
  });
  const cookie = `${SESSION_COOKIE}=${response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''}`;
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { id: me.json().user.id, username, cookie };
};

/** Advance the clock in `step` slices, ticking each one, as the real interval would. */
const run = (from: number, ms: number, step = 500): number => {
  let now = from;
  const until = from + ms;
  while (now < until) {
    now = Math.min(now + step, until);
    rooms.tick(now);
  }
  return now;
};

const view = (player: Player | null): RoomView =>
  rooms.viewFor(ROOM, player?.id ?? null);

/** Chips sitting in front of every seat, bots included. */
const feltChips = (): number => {
  const room = rooms.get(ROOM);
  return room.table.players.reduce((sum, p) => sum + p.chips + p.committed, 0);
};

/**
 * The quantity that is actually conserved.
 *
 * The rake is the one way chips leave a table without a seat changing, so counting what
 * the house has taken alongside what is on the felt gives back a total that may only
 * move when somebody sits down or stands up.
 */
const feltPlusRake = (): number => feltChips() + rooms.get(ROOM).rakeCollected;

// ------------------------------------------------------------- seats & chips --

describe('taking a seat', () => {
  it('debits the buy-in and puts exactly that much on the felt', async () => {
    const player = await signUp('seat_buyin');

    const before = getBalance(db, player.id);
    rooms.join(player.id, player.username, ROOM, 1_000);

    expect(getBalance(db, player.id)).toBe(before - 1_000);
    const seat = rooms.findSeat(player.id);
    expect(seat).toEqual({ roomId: ROOM, seat: expect.any(Number) });
    expect(view(player).seats[seat?.seat ?? -1]?.chips).toBe(1_000);
    expect(auditBalances(db)).toEqual([]);
  });

  it('returns the whole stack on the way out', async () => {
    const player = await signUp('seat_cashout');
    rooms.join(player.id, player.username, ROOM, 1_000);

    const { balance, cashedOut, pending } = rooms.leave(player.id);
    expect(pending).toBe(false);
    expect(cashedOut).toBe(1_000);
    expect(balance).toBe(STARTING_CHIPS);
    expect(rooms.findSeat(player.id)).toBeNull();
    expect(auditBalances(db)).toEqual([]);
  });

  it('refuses a buy-in outside the table limits, and one you cannot afford', async () => {
    const player = await signUp('seat_limits');

    expect(() => rooms.join(player.id, player.username, ROOM, MIN_BUY_IN - 1)).toThrow(/buy-in/);
    expect(() => rooms.join(player.id, player.username, ROOM, 10_000_000)).toThrow();
    // A rejected buy-in must leave no seat and no ledger movement behind.
    expect(rooms.findSeat(player.id)).toBeNull();
    expect(getBalance(db, player.id)).toBe(STARTING_CHIPS);
    expect(auditBalances(db)).toEqual([]);
  });

  it('holds one seat per account across the whole floor', async () => {
    const player = await signUp('seat_unique');
    rooms.join(player.id, player.username, ROOM, 500);

    expect(() => rooms.join(player.id, player.username, ROOM, 500)).toThrow(/already seated/);
    expect(() => rooms.join(player.id, player.username, 'table-velvet', 500)).toThrow(/already seated/);

    // And the database says so independently of the in-memory guard, so a second
    // process could not seat the same account twice either.
    expect(() =>
      db
        .prepare(
          `INSERT INTO room_seats (room_id, seat, user_id, buy_in, joined_at)
           VALUES ('table-velvet', 5, ?, 500, 0)`,
        )
        .run(player.id),
    ).toThrow(/UNIQUE/);
  });

  it('queues a mid-hand stand-up and honours it when the hand ends', async () => {
    const player = await signUp('seat_midhand');
    rooms.join(player.id, player.username, ROOM, 1_000);

    let now = Date.now();
    rooms.tick(now);
    expect(view(player).handInProgress).toBe(true);

    // Refusing outright would mean clicking into the gap between hands and hoping, so
    // the request is taken and held: the seat stays, and nothing has been credited yet.
    const queued = rooms.leave(player.id);
    expect(queued).toEqual({ pending: true, balance: STARTING_CHIPS - 1_000, cashedOut: 0 });
    expect(rooms.findSeat(player.id)).not.toBeNull();
    const seat = rooms.findSeat(player.id)?.seat ?? -1;
    expect(view(player).seats[seat]?.leaving).toBe(true);

    // Chips in a live pot cannot come back mid-hand: they may yet be lost.
    expect(getBalance(db, player.id)).toBe(STARTING_CHIPS - 1_000);

    now = run(now, TURN_MS * 4);
    expect(rooms.findSeat(player.id)).toBeNull();
    expect(getBalance(db, player.id)).toBeGreaterThan(STARTING_CHIPS - 1_000);
    expect(auditBalances(db)).toEqual([]);
  });

  it('does not deal another hand to a seat on its way out', async () => {
    const player = await signUp('seat_leaving');
    rooms.join(player.id, player.username, ROOM, 1_000);

    let now = Date.now();
    rooms.tick(now);
    rooms.leave(player.id);

    // One more tick is enough to finish the hand they were in; from there they must be
    // gone rather than dealt into the next one.
    now = run(now, TURN_MS * 4);
    expect(rooms.findSeat(player.id)).toBeNull();
  });
});

// -------------------------------------------------------------------- bots --

describe('bots', () => {
  it('fill the table up to the target once a human sits down', async () => {
    const player = await signUp('bots_fill');
    expect(rooms.botCount(ROOM)).toBe(0);

    rooms.join(player.id, player.username, ROOM, 1_000);
    expect(rooms.botCount(ROOM)).toBe(TARGET_PLAYERS - 1);
  });

  it('clear out when the last human leaves', async () => {
    const player = await signUp('bots_clear');
    rooms.join(player.id, player.username, ROOM, 1_000);
    rooms.leave(player.id);

    expect(rooms.botCount(ROOM)).toBe(0);
    expect(view(null).seats.every((s) => !s.occupied)).toBe(true);
  });

  it('give up a seat when the table is full of them', async () => {
    const first = await signUp('bots_seat_first');
    rooms.join(first.id, first.username, ROOM, 1_000);

    // Fill every remaining seat with bots the way a busy table would be.
    const room = rooms.get(ROOM);
    for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
      if (room.occupants[seat] === null) {
        room.occupants[seat] = { kind: 'bot', id: 100 + seat };
        (room.table.players[seat] as holdem.HoldemPlayer).chips = 2_000;
        (room.table.players[seat] as holdem.HoldemPlayer).sittingOut = false;
      }
    }
    expect(rooms.botCount(ROOM)).toBe(SEAT_COUNT - 1);

    const second = await signUp('bots_seat_second');
    rooms.join(second.id, second.username, ROOM, 1_000);

    expect(rooms.findSeat(second.id)).not.toBeNull();
    expect(rooms.botCount(ROOM)).toBe(SEAT_COUNT - 2);
    expect(auditBalances(db)).toEqual([]);
  });
});

// ------------------------------------------------------------------ dealing --

describe('dealing', () => {
  it('does not deal to an empty table', () => {
    rooms.tick(Date.now() + 60_000);
    expect(view(null).handInProgress).toBe(false);
    expect(view(null).handsPlayed).toBe(0);
  });

  it('deals once a human and the bots are seated', async () => {
    const player = await signUp('deal_start');
    rooms.join(player.id, player.username, ROOM, 1_000);

    rooms.tick(Date.now());
    const state = view(player);
    expect(state.handInProgress).toBe(true);
    expect(state.handsPlayed).toBe(1);
    expect(state.seats[state.you ?? -1]?.hole).toHaveLength(2);
  });

  it('sits a mid-hand arrival out until the next deal', async () => {
    const first = await signUp('deal_early');
    rooms.join(first.id, first.username, ROOM, 1_000);

    let now = Date.now();
    rooms.tick(now);
    expect(view(first).handInProgress).toBe(true);

    const late = await signUp('deal_late');
    rooms.join(late.id, late.username, ROOM, 1_000);
    const lateSeat = rooms.findSeat(late.id)?.seat ?? -1;

    const during = view(late);
    expect(during.seats[lateSeat]?.waiting).toBe(true);
    expect(during.seats[lateSeat]?.hole).toBeUndefined();
    expect(during.seats[lateSeat]?.chips).toBe(1_000);

    // Play the hand out by timing the human seats out, then let the next deal land.
    now = run(now, TURN_MS * 8);
    const after = view(late);
    expect(after.handsPlayed).toBeGreaterThanOrEqual(2);
    expect(after.seats[lateSeat]?.waiting).toBe(false);
  });
});

// ------------------------------------------------------------------- clocks --

describe('the turn clock', () => {
  it('acts for a seat that runs out of time', async () => {
    const player = await signUp('clock_timeout');
    rooms.join(player.id, player.username, ROOM, 1_000);

    const start = Date.now();
    rooms.tick(start);
    const armed = view(player);
    expect(armed.yourTurn).toBe(true);
    expect(armed.deadline).not.toBeNull();
    expect((armed.deadline ?? 0) - start).toBeLessThanOrEqual(TURN_MS);

    rooms.tick((armed.deadline ?? start) + 1);

    const after = view(player);
    expect(after.yourTurn).toBe(false);
    // Against the table's whole log, not the view's tail: one timeout can be followed by
    // a dozen bot actions and a showdown, which would push the line off a 12-line view.
    expect(rooms.get(ROOM).table.log.some((l) => l.includes('ran out of time'))).toBe(true);
    // Checking is free and folding costs nothing further: a timeout can never commit
    // chips the seat did not already put in.
    const seat = after.seats[after.you ?? -1];
    expect(seat?.folded === true || seat?.lastAction === 'check').toBe(true);
  });

  it('gives every client the same instant to count down to', async () => {
    const player = await signUp('clock_shared');
    rooms.join(player.id, player.username, ROOM, 1_000);
    rooms.tick(Date.now());

    // A watcher sees the deadline too - otherwise their clock and the player's drift.
    expect(view(null).deadline).toBe(view(player).deadline);
    expect(view(null).turnMs).toBe(TURN_MS);
  });
});

describe('disconnects', () => {
  it('keeps the seat during the grace period and cashes it out after', async () => {
    const player = await signUp('grace_period');
    const buyIn = 600;
    rooms.join(player.id, player.username, ROOM, buyIn);
    rooms.setConnected(player.id, false);

    const seat = rooms.findSeat(player.id)?.seat ?? -1;
    expect(view(player).seats[seat]?.connected).toBe(false);

    // Halfway through the grace window the seat is still theirs, chips and all - the
    // hands keep being dealt to it, which is the point: you do not escape a bad spot
    // by pulling a cable.
    let now = run(Date.now(), DISCONNECT_GRACE_MS / 2);
    expect(rooms.findSeat(player.id)).not.toBeNull();

    // Past it the seat is stood up. What comes back is the stack that was in front of
    // it, not the buy-in: the difference went to the other players, legitimately.
    let lastStack = view(player).seats[seat]?.chips ?? 0;
    const until = now + DISCONNECT_GRACE_MS * 4;
    while (now < until && rooms.findSeat(player.id) !== null) {
      lastStack = rooms.get(ROOM).table.players[seat]?.chips ?? lastStack;
      now += 500;
      rooms.tick(now);
    }

    expect(rooms.findSeat(player.id)).toBeNull();
    expect(getBalance(db, player.id)).toBe(STARTING_CHIPS - buyIn + lastStack);
    expect(auditBalances(db)).toEqual([]);
  });

  it('restores the seat on reconnect', async () => {
    const player = await signUp('grace_reconnect');
    rooms.join(player.id, player.username, ROOM, 600);

    rooms.setConnected(player.id, false);
    const now = run(Date.now(), DISCONNECT_GRACE_MS / 2);
    rooms.setConnected(player.id, true);

    run(now, DISCONNECT_GRACE_MS * 4);
    expect(rooms.findSeat(player.id)).not.toBeNull();
    expect(view(player).seats[rooms.findSeat(player.id)?.seat ?? -1]?.connected).toBe(true);
  });
});

// ---------------------------------------------------------------- redaction --

describe('what each viewer is allowed to see', () => {
  it('hides every hole card from a watcher', async () => {
    const player = await signUp('redact_watcher');
    rooms.join(player.id, player.username, ROOM, 1_000);
    rooms.tick(Date.now());

    const watching = view(null);
    expect(watching.you).toBeNull();
    expect(watching.yourTurn).toBe(false);
    expect(watching.actions).toEqual([]);
    expect(watching.seats.every((seat) => seat.hole === undefined)).toBe(true);
    // And the cards really are dealt - the watcher is missing them, not the table.
    expect(view(player).seats.some((seat) => seat.hole !== undefined)).toBe(true);
  });

  it('shows a player their own cards and nobody else’s', async () => {
    const first = await signUp('redact_first');
    const second = await signUp('redact_second');
    rooms.join(first.id, first.username, ROOM, 1_000);
    rooms.join(second.id, second.username, ROOM, 1_000);
    rooms.tick(Date.now());

    const mine = view(first);
    const revealed = mine.seats.filter((seat) => seat.hole !== undefined);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.seat).toBe(mine.you);

    const theirs = view(second);
    expect(theirs.you).not.toBe(mine.you);
    expect(theirs.seats.filter((seat) => seat.hole !== undefined)[0]?.seat).toBe(theirs.you);
  });

  it('never serialises a hole card into a view that should not have it', async () => {
    const first = await signUp('redact_bytes_first');
    const second = await signUp('redact_bytes_second');
    rooms.join(first.id, first.username, ROOM, 1_000);
    rooms.join(second.id, second.username, ROOM, 1_000);

    let now = Date.now();
    for (let hand = 0; hand < 6; hand += 1) {
      now = run(now, TURN_MS * 6);
      const mine = view(first);
      const showdown = mine.result?.wentToShowdown === true;
      for (const seat of mine.seats) {
        if (seat.hole === undefined) continue;
        // Your own seat always, everyone else only once the hand was shown down.
        expect(seat.seat === mine.you || showdown).toBe(true);
      }
    }
  });
});

// -------------------------------------------------------------- persistence --

describe('surviving a restart', () => {
  it('brings back seats, stacks and the unique-seat guarantee', async () => {
    const player = await signUp('restart_player');
    rooms.join(player.id, player.username, ROOM, 1_000);
    const seat = rooms.findSeat(player.id)?.seat ?? -1;
    const stack = view(player).seats[seat]?.chips ?? 0;

    // A second server over the same database is what a restart looks like from here.
    const revived = await buildServer(db);
    const reborn = (revived as unknown as { rooms: RoomRegistry }).rooms;
    try {
      expect(reborn.findSeat(player.id)).toEqual({ roomId: ROOM, seat });
      expect(reborn.viewFor(ROOM, player.id).seats[seat]?.chips).toBe(stack);
      // Nobody is connected to a process that just started, whatever the snapshot said.
      expect(reborn.viewFor(ROOM, player.id).seats[seat]?.connected).toBe(false);
      // Standing up still returns the stack exactly once.
      expect(reborn.leave(player.id).cashedOut).toBe(stack);
      expect(auditBalances(db)).toEqual([]);
    } finally {
      await revived.close();
    }
  });
});

// -------------------------------------------------------------- conservation --

describe('chip conservation over a long session', () => {
  /**
   * The felt is **not** a closed system, and this test is careful to say so precisely.
   *
   * A bot that busts is replaced by a fresh one with a house-funded stack, so the total
   * on the table legitimately rises when a seat is refilled. What must never happen is a
   * chip appearing while the same set of players is just playing cards - that is the
   * shape of the bug that let pysino mint 4,918 chips out of a bad refund.
   *
   * So: totals are allowed to move on exactly the ticks where the seating changed, and
   * nowhere else - counting the rake as still on the table, since the house taking a
   * cut is a transfer out of the pot rather than chips going missing.
   */
  it('only ever changes the table total when a seat changes', async () => {
    const first = await signUp('conserve_first');
    const second = await signUp('conserve_second');
    rooms.join(first.id, first.username, ROOM, 800);
    rooms.join(second.id, second.username, ROOM, 800);

    // Occupant identities, not seat *kinds*: a bot busting and being replaced in the
    // same tick looks identical by kind, and that is exactly the case that has to count
    // as a seating change.
    const occupancy = (): string =>
      view(null).seats.map((seat) => seat.occupantId ?? '-').join('|');

    let total = feltPlusRake();
    let seating = occupancy();
    let now = Date.now();
    const moves: number[] = [];

    /**
     * A third player sits down partway through.
     *
     * The first version of this waited for a bot to bust, to prove the check was not
     * vacuously true - and that depended on how the bots happened to play. Seating a
     * real person is a seating change on demand, and its effect on the total is exactly
     * known, which turns "a change was explained" into "the change was this much".
     */
    const third = await signUp('conserve_third');
    const steps = (TURN_MS * 40) / 500;

    for (let step = 0; step < steps; step += 1) {
      if (step === Math.floor(steps / 2)) rooms.join(third.id, third.username, ROOM, 700);

      now += 500;
      rooms.tick(now);

      const nextTotal = feltPlusRake();
      const nextSeating = occupancy();
      if (nextTotal !== total) {
        // A total that moved has to be explained by a seat that moved with it.
        expect(nextSeating).not.toBe(seating);
        moves.push(nextTotal - total);
      }
      total = nextTotal;
      seating = nextSeating;
    }

    expect(view(first).handsPlayed).toBeGreaterThan(3);
    // Exactly one change, and exactly the third player's buy-in - so the loop above was
    // genuinely watching, and nothing else moved the total while cards were being dealt.
    expect(moves).toEqual([700]);
    // And the house really was taking a cut over that stretch, so the rake term above
    // was carrying weight rather than sitting at zero.
    expect(rooms.get(ROOM).rakeCollected).toBeGreaterThan(0);

    // Neither wallet moved while the players were seated: chips at a table are not in a
    // wallet, and the only two transfer points are join and leave.
    expect(getBalance(db, first.id)).toBe(STARTING_CHIPS - 800);
    expect(getBalance(db, second.id)).toBe(STARTING_CHIPS - 800);
    expect(auditBalances(db)).toEqual([]);

    // Everyone stands up. A queued leave is honoured by the tick, so drive it until
    // the floor is empty of humans rather than assuming one call finishes the job.
    const buyIns: Record<string, number> = { [first.id]: 800, [second.id]: 800, [third.id]: 700 };
    for (const player of [first, second, third]) rooms.leave(player.id);

    // Drive until the floor is empty rather than for a fixed stretch. A queued leave is
    // honoured between hands, and how long the hand in progress has left to run is not
    // something this test should be guessing at.
    const seated = () => [first, second, third].filter((p) => rooms.findSeat(p.id) !== null);
    for (let step = 0; step < 400 && seated().length > 0; step += 1) {
      now += 500;
      rooms.tick(now);
    }
    expect(seated()).toEqual([]);

    for (const player of [first, second, third]) {
      expect(rooms.findSeat(player.id)).toBeNull();
      const payouts = recentLedger(db, player.id, 20).filter((row) => row.reason === 'payout');
      const wagers = recentLedger(db, player.id, 20).filter((row) => row.reason === 'wager');
      expect(wagers.map((row) => row.delta)).toEqual([-(buyIns[player.id] ?? 0)]);
      expect(payouts).toHaveLength(1);
      expect(getBalance(db, player.id)).toBe(
        STARTING_CHIPS - (buyIns[player.id] ?? 0) + (payouts[0]?.delta ?? 0),
      );
    }
    expect(auditBalances(db)).toEqual([]);
  });
});

// --------------------------------------------------------------- the lobby --

describe('the lobby routes', () => {
  it('lists every table with its limits and occupancy', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tables' });
    expect(response.statusCode).toBe(200);

    const tables = response.json().tables as Array<Record<string, number | string>>;
    expect(tables.length).toBeGreaterThanOrEqual(2);
    const lowball = tables.find((t) => t.id === ROOM);
    expect(lowball).toMatchObject({ seats: SEAT_COUNT, seated: 0, humans: 0 });
    expect(lowball?.minBuyIn).toBe(MIN_BUY_IN);
  });

  it('tells a reconnecting client where it was sitting', async () => {
    const player = await signUp('lobby_mine');
    expect((await app.inject({
      method: 'GET', url: '/api/tables/mine', headers: { cookie: player.cookie },
    })).json()).toBeNull();

    rooms.join(player.id, player.username, ROOM, 1_000);
    const mine = (await app.inject({
      method: 'GET', url: '/api/tables/mine', headers: { cookie: player.cookie },
    })).json();

    expect(mine.roomId).toBe(ROOM);
    expect(mine.room.you).toBe(mine.seat);
    expect(mine.room.seats[mine.seat].hole).toBeUndefined();
  });

  it('needs an account to ask about your seat', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tables/mine' });
    expect(response.statusCode).toBe(401);
  });
});
