/**
 * A shared hold'em table.
 *
 * The difference from a single-player session is that a room is *live*: it advances on a
 * timer whether or not anyone is looking, because somebody else's turn clock is running.
 * That drives almost every decision in this file.
 *
 *  - **Seats are fixed and owned.** Six of them. An account holds at most one seat across
 *    the whole floor, enforced by a unique index, so you cannot play yourself.
 *  - **Joining mid-hand sits you out** until the next deal. Dealing someone in halfway
 *    through would either give them cards nobody committed to or let them fold into a pot
 *    they never paid for.
 *  - **The clock belongs to the server.** Every turn carries a deadline the server set,
 *    broadcast so every client counts down to the same instant. On expiry the seat checks
 *    if it can and folds if it cannot - the same action a real dealer would take.
 *  - **Disconnecting does not free your chips.** They stay in the pot and the clock keeps
 *    running; reconnecting inside the grace window restores the seat exactly. That is the
 *    honest behaviour: the alternative is a player escaping a bad spot by pulling a cable.
 *  - **Bots fill empty seats and stand up for humans.** A table of one is not a game, and
 *    a bot holding a seat a person wants is worse than no bot at all.
 */

import { holdem } from '@websino/engine';
import { createCasualSource } from '@websino/fair';

export const SEAT_COUNT = 6;
export const MIN_HUMANS_BEFORE_BOTS = 1;
/** Seats kept filled by bots while the table is short. */
export const TARGET_PLAYERS = 4;

/** How long a seat gets to act before the server acts for it. */
export const TURN_MS = 20_000;
/** How long a disconnected seat keeps its chips before it is stood up. */
export const DISCONNECT_GRACE_MS = 60_000;
/** Pause between hands so results are readable. */
export const BETWEEN_HANDS_MS = 4_000;

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const MIN_BUY_IN = 200;
export const MAX_BUY_IN = 5_000;

export type Occupant =
  | {
      kind: 'human';
      userId: string;
      username: string;
      connected: boolean;
      disconnectedAt: number | null;
      /**
       * They asked to stand up while a hand was running.
       *
       * Refusing outright was the first attempt and it is not usable: hands come every
       * few seconds, so "finish the hand first" means clicking into a four-second
       * window and hoping. A real poker client takes the request and honours it at the
       * end of the hand, which is also the only point at which it *can* be honoured -
       * their chips are in the pot until then.
       */
      leaving?: boolean;
    }
  /**
   * `id` is a per-table serial, not a seat number.
   *
   * A bot can bust and be replaced by a fresh one in the same instant, and without an
   * identity there is no way to tell "this bot is still here" from "a different bot with
   * a new stack is". The client keys a seat's avatar on it, and a test uses it to insist
   * that the table total never moves except when an occupant actually changed.
   */
  | { kind: 'bot'; id: number }
  | null;

export interface RoomState {
  id: string;
  name: string;
  /** Engine state. Seat index in `table.players` matches `occupants` index. */
  table: holdem.HoldemTable;
  occupants: Occupant[];
  /** Seats that joined mid-hand and are waiting for the next deal. */
  waiting: number[];
  /** Epoch ms the current turn expires, or null when nobody is on the clock. */
  deadline: number | null;
  /** Epoch ms the next hand may start, or null when a hand is running. */
  nextHandAt: number | null;
  botSeed: number;
  /** Serial for bot identities. Only ever increments. */
  botsSeated: number;
  handsPlayed: number;
}

/**
 * Seats are always present in the engine's player array, occupied or not.
 *
 * Keeping the array a fixed length means a seat index is stable for the life of the room:
 * side pots reference seats, and a compacting array would silently repoint them.
 */
export function createRoom(id: string, name: string): RoomState {
  const players = Array.from({ length: SEAT_COUNT }, (_, seat) =>
    holdem.makePlayer(seat, `Seat ${seat + 1}`, 0),
  );
  // An empty seat is sitting out, which is how the engine already skips it.
  for (const p of players) p.sittingOut = true;

  return {
    id,
    name,
    table: holdem.createTable(players, SMALL_BLIND, BIG_BLIND),
    occupants: Array.from({ length: SEAT_COUNT }, () => null),
    waiting: [],
    deadline: null,
    nextHandAt: Date.now(),
    botSeed: (Date.now() ^ 0x5f3759df) >>> 0,
    botsSeated: 0,
    handsPlayed: 0,
  };
}

export const occupiedSeats = (room: RoomState): number[] =>
  room.occupants.map((o, seat) => (o ? seat : -1)).filter((seat) => seat >= 0);

export const humanSeats = (room: RoomState): number[] =>
  room.occupants.map((o, seat) => (o?.kind === 'human' ? seat : -1)).filter((s) => s >= 0);

export const botSeats = (room: RoomState): number[] =>
  room.occupants.map((o, seat) => (o?.kind === 'bot' ? seat : -1)).filter((s) => s >= 0);

export const seatOfUser = (room: RoomState, userId: string): number | null => {
  const seat = room.occupants.findIndex((o) => o?.kind === 'human' && o.userId === userId);
  return seat < 0 ? null : seat;
};

/** A seat with chips that is not waiting to be dealt in. */
const isPlayable = (room: RoomState, seat: number): boolean =>
  room.occupants[seat] !== null &&
  (room.table.players[seat] as holdem.HoldemPlayer).chips > 0 &&
  !room.waiting.includes(seat);

export const playableSeats = (room: RoomState): number[] =>
  occupiedSeats(room).filter((seat) => isPlayable(room, seat));

/**
 * Seat a human. Returns the seat index.
 *
 * The caller must already have debited the buy-in - this only ever *places* chips that
 * have left a wallet, which is what keeps the two halves of the transfer in step.
 */
export function seatHuman(
  room: RoomState,
  userId: string,
  username: string,
  buyIn: number,
  preferredSeat?: number,
): number {
  if (seatOfUser(room, userId) !== null) throw new Error('you are already at this table');

  let seat = preferredSeat !== undefined && room.occupants[preferredSeat] === null
    ? preferredSeat
    : room.occupants.findIndex((o) => o === null);

  // Every seat taken, but some by bots: a bot gives up its seat for a person.
  if (seat < 0) {
    const bots = botSeats(room);
    // Prefer a bot that is not currently in a hand, so nobody's pot vanishes.
    const idle = bots.find((s) => !holdem.inHand(room.table.players[s] as holdem.HoldemPlayer));
    seat = idle ?? bots[0] ?? -1;
    if (seat < 0) throw new Error('the table is full');
    standUp(room, seat);
  }

  const player = room.table.players[seat] as holdem.HoldemPlayer;
  player.name = username;
  player.chips = buyIn;
  player.isBot = false;
  player.profile = null;
  player.sittingOut = false;
  player.folded = false;
  player.hole = [];
  player.bet = 0;
  player.committed = 0;
  player.allIn = false;
  player.lastAction = '';

  room.occupants[seat] = {
    kind: 'human', userId, username, connected: true, disconnectedAt: null,
  };

  // Mid-hand arrivals wait: dealing someone in halfway would either hand them cards
  // nobody committed to or let them fold into a pot they never paid for.
  if (room.table.handInProgress) {
    room.waiting.push(seat);
    player.sittingOut = true;
  }
  return seat;
}

/** Empty a seat. Returns whatever stack was left, for the caller to credit. */
export function standUp(room: RoomState, seat: number): number {
  const player = room.table.players[seat] as holdem.HoldemPlayer;
  const stack = player.chips;

  room.occupants[seat] = null;
  room.waiting = room.waiting.filter((s) => s !== seat);
  player.name = `Seat ${seat + 1}`;
  player.chips = 0;
  player.isBot = false;
  player.profile = null;
  player.sittingOut = true;
  player.folded = true;
  player.hole = [];
  player.bet = 0;
  player.committed = 0;
  player.allIn = false;
  player.hasActed = false;
  player.lastAction = '';
  player.wonLast = 0;
  return stack;
}

/**
 * Keep the table populated while humans are present, and never at the cost of a seat
 * somebody wants. Bots are only added between hands.
 */
export function balanceBots(room: RoomState): void {
  if (room.table.handInProgress) return;

  const humans = humanSeats(room).length;
  if (humans < MIN_HUMANS_BEFORE_BOTS) {
    // Nobody is here. Clear the bots out rather than letting them play to an empty room.
    for (const seat of botSeats(room)) standUp(room, seat);
    return;
  }

  const random = createCasualSource(room.botSeed);
  room.botSeed = (room.botSeed * 1_103_515_245 + 12_345) >>> 0;

  // Remove bots that busted - a bot with no chips is an empty seat wearing a hat.
  for (const seat of botSeats(room)) {
    if ((room.table.players[seat] as holdem.HoldemPlayer).chips <= 0) standUp(room, seat);
  }

  const taken = new Set(
    occupiedSeats(room).map((s) => (room.table.players[s] as holdem.HoldemPlayer).name),
  );
  const names = random.shuffle(holdem.BOT_NAMES).filter((n) => !taken.has(n));
  const profiles = random.shuffle(holdem.PROFILES);

  let added = 0;
  while (occupiedSeats(room).length < TARGET_PLAYERS) {
    const seat = room.occupants.findIndex((o) => o === null);
    if (seat < 0) break;
    const name = names[added % Math.max(1, names.length)] ?? `Bot ${seat + 1}`;
    const profile = profiles[added % profiles.length] as holdem.AIProfile;

    const player = room.table.players[seat] as holdem.HoldemPlayer;
    player.name = name;
    player.chips = 2_000;
    player.isBot = true;
    player.profile = profile;
    player.sittingOut = false;
    player.folded = false;
    player.hole = [];
    room.botsSeated += 1;
    room.occupants[seat] = { kind: 'bot', id: room.botsSeated };
    added += 1;
  }
}

/** Note that a seat wants out. Honoured by the tick as soon as the hand ends. */
export function requestLeave(room: RoomState, seat: number): void {
  const occupant = room.occupants[seat];
  if (occupant?.kind !== 'human') return;
  // The flag, and nothing else.
  //
  // Marking them `sittingOut` here was the obvious-looking move and it is wrong twice
  // over: mid-hand it takes a player the engine is still waiting on out of the hand, so
  // `toAct` points at a seat with no legal actions; and it is unnecessary, because the
  // tick stands them up before the next deal anyway.
  occupant.leaving = true;
}

/**
 * Seats that asked to leave and can now be stood up.
 *
 * Only ever between hands - never mid-hand, not even for a player who has folded. A
 * folded seat's `committed` chips are still in the live pot, and standing it up clears
 * `committed`, which would shrink the pot and destroy those chips outright. That is the
 * exact shape of the bug that let pysino mint chips, pointing the other way.
 */
export function leavingSeats(room: RoomState): number[] {
  if (room.table.handInProgress) return [];
  return humanSeats(room).filter(
    (seat) => (room.occupants[seat] as { leaving?: boolean } | null)?.leaving === true,
  );
}

/** Mark a seat's connection state. Chips stay put either way. */
export function setConnected(room: RoomState, seat: number, connected: boolean): void {
  const occupant = room.occupants[seat];
  if (!occupant || occupant.kind !== 'human') return;
  occupant.connected = connected;
  occupant.disconnectedAt = connected ? null : Date.now();
}

/**
 * Seats whose grace period has run out and should be stood up.
 *
 * Never during a hand. "Not in the hand" is not good enough: a player who folded still
 * has their `committed` chips in the live pot, and standing a seat up clears
 * `committed` - which would shrink the pot and destroy those chips. Every exit from a
 * table therefore waits for the hand to finish, which is also the only moment the chips
 * in front of a seat are unambiguously that seat's.
 */
export function expiredSeats(room: RoomState, now = Date.now()): number[] {
  if (room.table.handInProgress) return [];
  return humanSeats(room).filter((seat) => {
    const occupant = room.occupants[seat];
    if (!occupant || occupant.kind !== 'human' || occupant.connected) return false;
    if (occupant.disconnectedAt === null) return false;
    return now - occupant.disconnectedAt > DISCONNECT_GRACE_MS;
  });
}

/** Arm the clock for whoever is to act, or clear it. */
export function armClock(room: RoomState, now = Date.now()): void {
  room.deadline = room.table.toAct === null || holdem.isHandOver(room.table)
    ? null
    : now + TURN_MS;
}

/**
 * The action the server takes for a seat that ran out of time.
 *
 * Check when it is free, fold when it is not - exactly what a dealer does, and the only
 * choice that cannot cost the seat chips it did not choose to commit.
 */
export function timeoutAction(room: RoomState): holdem.HoldemAction {
  return holdem.legalActions(room.table).includes('check') ? 'check' : 'fold';
}
