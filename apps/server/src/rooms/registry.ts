/**
 * The floor: every live room, its clock, and the two halves of every chip transfer.
 *
 * Rooms live in memory so the tick is cheap, and are snapshotted to SQLite after every
 * mutation. That is not belt-and-braces: a seat's buy-in has already left its owner's
 * wallet, so a restart that lost the room would strand real stacks. Blackjack and crash
 * survive a restart and shared tables have to as well.
 *
 * Chips move in exactly two places, both here:
 *   `join`  debits the buy-in and seats the player with it
 *   `leave` credits whatever stack is left and empties the seat
 * Neither is reachable without the other, which is the shape pysino got wrong when it
 * refunded a table buy-in that had never been debited.
 */

import { randomUUID } from 'node:crypto';

import {
  assertValidBet, holdem, type RoomSeatView, type RoomSummary, type RoomView,
} from '@websino/engine';
import { createCasualSource } from '@websino/fair';

import type { Db } from '../db/index.js';
import { applyLedger, getBalance } from '../db/ledger.js';
import { takeStream } from '../fair/seeds.js';
import {
  armClock, balanceBots, BETWEEN_HANDS_MS, botSeats, createRoom, expiredSeats, humanSeats,
  leavingSeats, MAX_BUY_IN, MIN_BUY_IN, occupiedSeats, playableSeats, requestLeave,
  seatHuman, seatOfUser, SEAT_COUNT, setConnected, standUp, timeoutAction, TURN_MS,
  type Occupant, type RoomState,
} from './room.js';

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

/** How long after a table wakes up the first hand is dealt. */
const WAKE_MS = 1_000;

/** The tables the floor opens with. More could be created on demand later. */
const DEFAULT_ROOMS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'table-lowball', name: 'Lowball Lounge' },
  { id: 'table-velvet', name: 'The Velvet Room' },
];

/**
 * A stable handle for whoever is in a seat.
 *
 * Not the seat number: seats outlive their occupants. A client keys a seat's avatar and
 * its animations on this, so a bot busting and being replaced reads as a new player
 * rather than the same one suddenly richer.
 */
function occupantIdOf(occupant: Occupant | undefined): string | null {
  if (!occupant) return null;
  return occupant.kind === 'human' ? occupant.userId : `bot:${occupant.id}`;
}

export type { RoomSeatView, RoomSummary, RoomView };

export class RoomRegistry {
  readonly #db: Db;
  readonly #rooms = new Map<string, RoomState>();
  /** Called with a room id whenever its state changed, so sockets can re-send. */
  #onChange: (roomId: string) => void = () => {};
  #timer: ReturnType<typeof setInterval> | null = null;

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
      .prepare("SELECT id, name, state_json FROM rooms WHERE game = 'holdem'")
      .all() as Array<{ id: string; name: string; state_json: string }>;

    for (const row of rows) {
      const state = JSON.parse(row.state_json) as RoomState;
      // Nobody is connected to a freshly restarted process, whatever the snapshot said.
      for (const occupant of state.occupants) {
        if (occupant?.kind === 'human') {
          occupant.connected = false;
          occupant.disconnectedAt = Date.now();
        }
      }
      state.deadline = null;
      this.#rooms.set(state.id, state);
    }

    for (const { id, name } of DEFAULT_ROOMS) {
      if (!this.#rooms.has(id)) {
        const room = createRoom(id, name);
        this.#rooms.set(id, room);
        this.#save(room);
      }
    }
  }

  #save(room: RoomState): void {
    this.#db
      .prepare(
        `INSERT INTO rooms (id, game, name, state_json, updated_at)
         VALUES (?, 'holdem', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(room.id, room.name, JSON.stringify(room), Date.now());
    this.#onChange(room.id);
  }

  // ----------------------------------------------------------------- access --

  get(roomId: string): RoomState {
    const room = this.#rooms.get(roomId);
    if (!room) throw new RoomError(`no such table: ${roomId}`);
    return room;
  }

  list(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      smallBlind: room.table.smallBlind,
      bigBlind: room.table.bigBlind,
      minBuyIn: MIN_BUY_IN,
      maxBuyIn: MAX_BUY_IN,
      seated: occupiedSeats(room).length,
      humans: humanSeats(room).length,
      seats: SEAT_COUNT,
      handsPlayed: room.handsPlayed,
    }));
  }

  /** Which room a user is sitting at, if any. */
  findSeat(userId: string): { roomId: string; seat: number } | null {
    for (const room of this.#rooms.values()) {
      const seat = seatOfUser(room, userId);
      if (seat !== null) return { roomId: room.id, seat };
    }
    return null;
  }

  // ------------------------------------------------------------ chip moves --

  join(userId: string, username: string, roomId: string, buyIn: number): RoomView {
    const room = this.get(roomId);
    if (this.findSeat(userId)) throw new RoomError('you are already seated at a table');
    if (buyIn < MIN_BUY_IN || buyIn > MAX_BUY_IN) {
      throw new RoomError(`buy-in must be between ${MIN_BUY_IN} and ${MAX_BUY_IN}`);
    }
    assertValidBet(buyIn, getBalance(this.#db, userId));

    const seat = seatHuman(room, userId, username, buyIn);

    // Debit and record the seat in one transaction: the buy-in row is what `leave`
    // reconciles against, so it must not be able to exist without the debit.
    //
    // If that transaction fails the seat has to come back out, or the table would be
    // holding chips nobody paid for - the same class of bug as refunding a buy-in that
    // was never debited, pointing the other way.
    try {
      this.#db.transaction(() => {
        applyLedger(this.#db, userId, [{ delta: -buyIn, reason: 'wager' }]);
        this.#db
          .prepare(
            `INSERT INTO room_seats (room_id, seat, user_id, buy_in, joined_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(roomId, seat, userId, buyIn, Date.now());
      })();
    } catch (cause) {
      standUp(room, seat);
      this.#save(room);
      throw cause;
    }

    balanceBots(room);
    this.#save(room);
    return this.view(room, userId);
  }

  /**
   * Stand up, or ask to.
   *
   * Chips in a live pot cannot come back mid-hand - they may yet be lost - so a request
   * made during a hand is queued and honoured by the tick the moment the hand ends.
   * `pending` says which happened, and it is the caller's job to tell the player rather
   * than leave them clicking a button that appears to do nothing.
   */
  leave(userId: string): { pending: boolean; balance: number; cashedOut: number } {
    const found = this.findSeat(userId);
    if (!found) throw new RoomError('you are not seated at a table');
    const room = this.get(found.roomId);

    // Queued whenever a hand is running, not just when the caller is still in it: a
    // folded seat's committed chips are in the live pot too, and cashing it out would
    // clear them from the pot rather than pay them to whoever wins it.
    if (room.table.handInProgress) {
      requestLeave(room, found.seat);
      this.#save(room);
      return { pending: true, balance: getBalance(this.#db, userId), cashedOut: 0 };
    }

    const stack = this.#cashOutSeat(room, found.seat, userId, { record: true });
    this.#save(room);
    return { pending: false, balance: getBalance(this.#db, userId), cashedOut: stack };
  }

  // ---------------------------------------------------------------- acting --

  act(userId: string, action: holdem.HoldemAction, amount: number): RoomView {
    const found = this.findSeat(userId);
    if (!found) throw new RoomError('you are not seated at a table');
    const room = this.get(found.roomId);

    if (room.table.toAct !== found.seat) throw new RoomError('it is not your turn');
    holdem.act(room.table, action, amount);
    this.#advance(room, Date.now());
    this.#save(room);
    return this.view(room, userId);
  }

  setConnected(userId: string, connected: boolean): void {
    const found = this.findSeat(userId);
    if (!found) return;
    const room = this.get(found.roomId);
    setConnected(room, found.seat, connected);
    this.#save(room);
  }

  // ------------------------------------------------------------------ tick --

  /**
   * One interval drives every room. Rooms are cheap and few; a timer per seat would be
   * a lot of machinery for the same effect, and harder to reason about when two fire at
   * once.
   */
  start(intervalMs = 500): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), intervalMs);
    // Never hold the process open on our own account.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick(now = Date.now()): void {
    for (const room of this.#rooms.values()) {
      let changed = false;

      // Seats whose grace period ran out, and seats that asked to stand up during a
      // hand that has since finished. Both are out, and both get their stack back.
      for (const seat of new Set([...expiredSeats(room, now), ...leavingSeats(room)])) {
        const occupant = room.occupants[seat] as Extract<Occupant, { kind: 'human' }>;
        this.#cashOutSeat(room, seat, occupant.userId, { record: true });
        room.table.log.push(
          occupant.leaving === true
            ? `${occupant.username} stood up`
            : `${occupant.username} timed out and was stood up`,
        );
        balanceBots(room);
        changed = true;
      }

      if (room.table.handInProgress) {
        const toAct = room.table.toAct;
        const occupant = toAct === null ? null : room.occupants[toAct];
        /**
         * Someone who asked to stand up does not get twenty seconds.
         *
         * They have already decided; the clock exists to give a player time to decide.
         * Holding the table for them on every remaining street means five other people
         * waiting a minute for someone who has left the building - and they cannot be
         * stood up yet, because their chips are in a live pot.
         */
        const away = occupant?.kind === 'human' && occupant.leaving === true;

        // A bot on the clock acts at once; there is nothing to wait for.
        if (toAct !== null && (occupant?.kind === 'bot' || away)) {
          if (away) {
            holdem.act(room.table, timeoutAction(room));
            this.#advance(room, now);
          } else {
            this.#advance(room, now);
          }
          changed = true;
        } else if (room.deadline !== null && now >= room.deadline) {
          // A human ran out of time. Check if free, fold if not.
          //
          // The seat is read before acting: afterwards `toAct` is the *next* player, and
          // logging that one is how you end up blaming the wrong seat for a timeout.
          const seat = room.table.toAct;
          const action = timeoutAction(room);
          holdem.act(room.table, action);
          if (seat !== null) {
            const name = (room.table.players[seat] as holdem.HoldemPlayer).name;
            room.table.log.push(`${name} ran out of time and ${action}ed`);
          }
          this.#advance(room, now);
          changed = true;
        }
      } else if (room.nextHandAt !== null && now >= room.nextHandAt) {
        if (this.#tryDeal(room, now)) changed = true;
      }

      if (changed) this.#save(room);
    }
  }

  /**
   * The other half of `join`: empty a seat and credit whatever stack it held.
   *
   * The single place a table ever pays back into a wallet, so every exit - standing up,
   * a queued leave, a grace period running out - goes through here and cannot disagree
   * with the others about how much came back.
   */
  #cashOutSeat(
    room: RoomState,
    seat: number,
    userId: string,
    { record = false }: { record?: boolean } = {},
  ): number {
    const row = this.#db
      .prepare('SELECT buy_in FROM room_seats WHERE room_id = ? AND seat = ?')
      .get(room.id, seat) as { buy_in: number } | undefined;
    const stack = standUp(room, seat);

    this.#db.transaction(() => {
      if (stack > 0) applyLedger(this.#db, userId, [{ delta: stack, reason: 'payout' }]);
      this.#db
        .prepare('DELETE FROM room_seats WHERE room_id = ? AND seat = ?')
        .run(room.id, seat);
      if (record && row) {
        this.#db
          .prepare(
            `INSERT INTO rounds (id, user_id, game, seed_pair_id, nonce, bet, payout,
                                 config_json, outcome_json, created_at)
             SELECT ?, ?, 'holdem-table', id, nonce, ?, ?, ?, ?, ?
             FROM seed_pairs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .run(
            randomUUID(), userId, row.buy_in, stack,
            JSON.stringify({ roomId: room.id, buyIn: row.buy_in }),
            JSON.stringify({ cashedOut: stack }),
            Date.now(), userId,
          );
      }
    })();

    balanceBots(room);
    return stack;
  }

  /** Deal if the table can support a hand. Returns whether anything happened. */
  #tryDeal(room: RoomState, now: number): boolean {
    // Anyone who was waiting can be dealt in now.
    for (const seat of room.waiting) {
      const player = room.table.players[seat] as holdem.HoldemPlayer;
      if (player.chips > 0) player.sittingOut = false;
    }
    room.waiting = [];
    balanceBots(room);

    if (humanSeats(room).length === 0) {
      // An empty table should not burn nonces dealing to nobody.
      room.nextHandAt = null;
      return false;
    }
    if (playableSeats(room).length < 2) {
      room.nextHandAt = now + BETWEEN_HANDS_MS;
      return false;
    }

    // The shuffle comes off the fair stream of the first seated human, so the hand is
    // verifiable by somebody with a stake in it rather than by nobody.
    const anchor = humanSeats(room)
      .map((seat) => room.occupants[seat])
      .find((o): o is Extract<Occupant, { kind: 'human' }> => o?.kind === 'human');
    if (!anchor) return false;

    const { stream } = takeStream(this.#db, anchor.userId);
    holdem.dealHand(room.table, stream);
    room.handsPlayed += 1;
    room.nextHandAt = null;
    this.#advance(room, now);
    return true;
  }

  /**
   * Push the table forward: let bots act, settle a finished hand, and re-arm the clock.
   *
   * Bounded rather than `while (true)` - a bug that stopped advancing would otherwise
   * spin a timer callback forever rather than surfacing.
   *
   * `now` is threaded in rather than read from the clock, so every deadline this arms is
   * measured from the instant the tick is processing. Reading `Date.now()` here instead
   * made a twenty-second turn occasionally twenty seconds and one millisecond - harmless
   * in itself, but it meant a tick handed an explicit instant was not actually driven by
   * it, which is the one property both the tests and a caught-up tick depend on.
   */
  #advance(room: RoomState, now: number): void {
    const random = createCasualSource(room.botSeed);
    room.botSeed = (room.botSeed * 1_103_515_245 + 12_345) >>> 0;

    for (let guard = 0; guard < 400; guard += 1) {
      if (holdem.isHandOver(room.table)) {
        room.deadline = null;
        // Counted once per hand: `#advance` is reached many times after settlement,
        // and the result stays put until the next deal replaces it.
        if (room.table.result && room.rakedHand !== room.table.handNumber) {
          room.rakeCollected += room.table.result.rake;
          room.rakedHand = room.table.handNumber;
        }
        if (room.nextHandAt === null) room.nextHandAt = now + BETWEEN_HANDS_MS;
        return;
      }
      const seat = room.table.toAct;
      if (seat === null) {
        room.deadline = null;
        return;
      }
      if (room.occupants[seat]?.kind !== 'bot') {
        armClock(room, now);
        return;
      }
      holdem.playBotTurn(room.table, random);
    }
    throw new RoomError('table failed to settle');
  }

  // ------------------------------------------------------------------ view --

  /**
   * Build the view for one viewer.
   *
   * Hole cards are present only for the viewer's own seat, and for everyone still in at
   * a showdown. Watchers see the table and nobody's cards - which is what makes it safe
   * to let people watch at all.
   */
  view(room: RoomState, userId: string | null): RoomView {
    const t = room.table;
    const you = userId === null ? null : seatOfUser(room, userId);
    const showdown = t.result?.wentToShowdown === true;
    const descriptions = new Map((t.result?.entries ?? []).map((e) => [e.seat, e.description]));

    const seats: RoomSeatView[] = t.players.map((p, seat) => {
      const occupant = room.occupants[seat];
      const reveal = (you !== null && seat === you) || (showdown && holdem.inHand(p));
      return {
        seat,
        occupied: occupant !== null,
        kind: occupant?.kind ?? null,
        occupantId: occupantIdOf(occupant),
        name: occupant ? p.name : `Seat ${seat + 1}`,
        style: p.profile?.name ?? null,
        connected: occupant?.kind === 'human' ? occupant.connected : true,
        chips: p.chips,
        bet: p.bet,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
        sittingOut: p.sittingOut,
        waiting: room.waiting.includes(seat),
        leaving: occupant?.kind === 'human' && occupant.leaving === true,
        lastAction: p.lastAction,
        wonLast: p.wonLast,
        isButton: seat === t.button,
        isTurn: t.toAct === seat,
        ...(reveal && p.hole.length > 0 ? { hole: [...p.hole] } : {}),
        ...(showdown ? { handDescription: descriptions.get(seat) ?? null } : {}),
      };
    });

    const yourPlayer = you === null ? null : (t.players[you] as holdem.HoldemPlayer);
    const yourTurn = you !== null && t.toAct === you && !holdem.isHandOver(t);

    return {
      id: room.id,
      name: room.name,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      minBuyIn: MIN_BUY_IN,
      maxBuyIn: MAX_BUY_IN,
      street: t.street,
      board: [...t.board],
      pot: holdem.potOf(t),
      seats,
      you,
      toAct: t.toAct,
      yourTurn,
      actions: yourTurn && yourPlayer ? holdem.legalActions(t, yourPlayer) : [],
      toCall: yourPlayer ? holdem.toCall(t, yourPlayer) : 0,
      minRaiseTo: yourPlayer ? holdem.minRaiseTo(t, yourPlayer) : 0,
      maxRaiseTo: yourPlayer ? holdem.maxRaiseTo(t, yourPlayer) : 0,
      deadline: room.deadline,
      turnMs: TURN_MS,
      nextHandAt: room.nextHandAt,
      handInProgress: t.handInProgress,
      handNumber: t.handNumber,
      handsPlayed: room.handsPlayed,
      log: t.log.slice(-12),
      result: t.result
        ? {
            wentToShowdown: t.result.wentToShowdown,
            winners: t.result.winners,
            rake: t.result.rake,
          }
        : null,
      balance: userId === null ? 0 : getBalance(this.#db, userId),
    };
  }

  viewFor(roomId: string, userId: string | null): RoomView {
    return this.view(this.get(roomId), userId);
  }

  /**
   * Wake a table that went idle because nobody was sitting at it.
   *
   * Sooner than the inter-hand pause on purpose: that pause exists so a finished hand
   * stays readable, and an idle table has no result to read. Making someone who just
   * sat down watch an empty felt for four seconds is a bad first impression of a live
   * game, so they get a beat instead.
   */
  wake(roomId: string): void {
    const room = this.get(roomId);
    if (!room.table.handInProgress && room.nextHandAt === null) {
      room.nextHandAt = Date.now() + WAKE_MS;
      this.#save(room);
    }
  }

  /** Every occupied seat's bot count, for tests. */
  botCount(roomId: string): number {
    return botSeats(this.get(roomId)).length;
  }
}
