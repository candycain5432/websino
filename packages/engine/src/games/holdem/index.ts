/**
 * No-limit Texas Hold'em: blinds, four betting streets, short-stack all-ins and
 * layered side pots.
 *
 * **Fairness draw order.** One `shuffle()` of a 52-card deck at the start of the hand.
 * Hole cards come off it two at a time in seat order from the small blind, then the
 * board. The whole hand is therefore fixed before anyone acts, and one
 * `(serverSeed, clientSeed, nonce)` replays it exactly.
 *
 * **Chips are conserved, and that is tested.** The total across every seat plus the pot
 * is invariant for the life of a hand: money only ever moves between players. pysino's
 * hold'em shipped a bug that minted 4,918 chips, so here it is an assertion rather than
 * an intention - `totalChips` is checked before and after every hand in the tests, and
 * after every individual action.
 *
 * Ported from pysino's `games/holdem.py`. Two things changed structurally:
 *
 *  - `id(player)` as a dict key becomes the **seat index**. Python was comparing object
 *    identity; JavaScript would have compared references, which works until state is
 *    serialised to the database and back, at which point every lookup silently misses.
 *  - Bots take a `CasualSource`, so handing them the fair stream is a compile error.
 *    pysino's `estimate_equity` drew from the deal's own generator, which meant a bot
 *    thinking perturbed the cards still to come.
 */

import type { CasualSource } from '@websino/fair';

import { type Card, freshDeck } from '../../cards.js';
import { describe as describeRank, evaluate, type HandRank } from '../../handEval.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'complete';
export type HoldemAction = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/** How many community cards are face up on each street. */
export const BOARD_SIZE: Record<Street, number> = {
  preflop: 0, flop: 3, turn: 4, river: 5, complete: 5,
};

export class HoldemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldemError';
  }
}

/** Knobs that give each bot a recognisable style. */
export interface AIProfile {
  name: string;
  /** Equity needed before the bot is happy to put money in. */
  tightness: number;
  /** How often a good hand becomes a raise rather than a call. */
  aggression: number;
  /** Chance of firing at a pot with nothing. */
  bluff: number;
  /** Monte Carlo samples per decision; higher is slower but sharper. */
  iterations: number;
}

export const PROFILES: readonly AIProfile[] = [
  { name: 'Rock', tightness: 0.62, aggression: 0.25, bluff: 0.02, iterations: 240 },
  { name: 'Shark', tightness: 0.50, aggression: 0.55, bluff: 0.12, iterations: 240 },
  { name: 'Maniac', tightness: 0.38, aggression: 0.75, bluff: 0.28, iterations: 240 },
  { name: 'Calling Station', tightness: 0.42, aggression: 0.10, bluff: 0.03, iterations: 240 },
  { name: 'Grinder', tightness: 0.55, aggression: 0.40, bluff: 0.07, iterations: 240 },
];

/** Bots are named separately from their style, so a seat shows both who and how. */
export const BOT_NAMES: readonly string[] = [
  'Marlowe', 'Dmitri', 'Odessa', 'Castellan', 'Winnie', 'Sable', 'Rook',
];

export interface HoldemPlayer {
  seat: number;
  name: string;
  chips: number;
  isBot: boolean;
  profile: AIProfile | null;
  hole: Card[];
  /** Chips pushed forward on the current street. */
  bet: number;
  /** Chips pushed forward across the whole hand. */
  committed: number;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
  lastAction: string;
  sittingOut: boolean;
  wonLast: number;
}

/** One layer of the pot, with the seats entitled to contest it. */
export interface Pot {
  amount: number;
  /** Seat indices, not player references - this survives a round trip through JSON. */
  eligible: number[];
  isSide: boolean;
}

export interface ShowdownEntry {
  seat: number;
  rank: HandRank | null;
  description: string | null;
  won: number;
}

export interface HandResult {
  winners: number[];
  entries: ShowdownEntry[];
  pots: Pot[];
  board: Card[];
  wentToShowdown: boolean;
}

export interface HoldemTable {
  players: HoldemPlayer[];
  smallBlind: number;
  bigBlind: number;
  button: number;
  street: Street;
  board: Card[];
  /** The shuffled deck. Secret: it is the rest of the hand. */
  deck: Card[];
  deckPosition: number;
  currentBet: number;
  minRaise: number;
  toAct: number | null;
  result: HandResult | null;
  handNumber: number;
  log: string[];
  /** True between `startHand` and settlement. */
  handInProgress: boolean;
}

export const makePlayer = (
  seat: number,
  name: string,
  chips: number,
  profile: AIProfile | null = null,
): HoldemPlayer => ({
  seat,
  name,
  chips,
  isBot: profile !== null,
  profile,
  hole: [],
  bet: 0,
  committed: 0,
  folded: false,
  allIn: false,
  hasActed: false,
  lastAction: '',
  sittingOut: false,
  wonLast: 0,
});

export function createTable(
  players: HoldemPlayer[],
  smallBlind = 10,
  bigBlind = 20,
): HoldemTable {
  if (players.length < 2) throw new HoldemError("hold'em needs at least two players");
  return {
    players,
    smallBlind,
    bigBlind,
    button: 0,
    street: 'complete',
    board: [],
    deck: [],
    deckPosition: 0,
    currentBet: 0,
    minRaise: bigBlind,
    toAct: null,
    result: null,
    handNumber: 0,
    log: [],
    handInProgress: false,
  };
}

// ----------------------------------------------------------------------- queries --

export const inHand = (p: HoldemPlayer): boolean => !p.folded && !p.sittingOut;
export const canAct = (p: HoldemPlayer): boolean => inHand(p) && !p.allIn;

export const potOf = (table: HoldemTable): number =>
  table.players.reduce((sum, p) => sum + p.committed, 0);

export const contenders = (table: HoldemTable): HoldemPlayer[] =>
  table.players.filter(inHand);

export const seated = (table: HoldemTable): HoldemPlayer[] =>
  table.players.filter((p) => !p.sittingOut);

export const currentPlayer = (table: HoldemTable): HoldemPlayer | null =>
  table.toAct === null ? null : (table.players[table.toAct] as HoldemPlayer);

export const isHandOver = (table: HoldemTable): boolean => table.street === 'complete';

/**
 * Every chip on the table: in stacks, plus whatever is out in front as commitment.
 *
 * This is the invariant the whole engine is judged by - it must be identical before a
 * hand, after every single action, and after settlement. Settlement therefore clears
 * `committed` as it pays, or the same chips would be counted in both places.
 */
export const totalChips = (table: HoldemTable): number =>
  table.players.reduce((sum, p) => sum + p.chips + p.committed, 0);

export const toCall = (table: HoldemTable, p: HoldemPlayer): number =>
  Math.max(0, Math.min(table.currentBet - p.bet, p.chips));

/** Smallest legal total bet for a raise, capped by the player's stack. */
export const minRaiseTo = (table: HoldemTable, p: HoldemPlayer): number =>
  Math.min(Math.max(table.currentBet + table.minRaise, table.bigBlind), p.bet + p.chips);

export const maxRaiseTo = (_table: HoldemTable, p: HoldemPlayer): number => p.bet + p.chips;

export function legalActions(table: HoldemTable, player?: HoldemPlayer): HoldemAction[] {
  const p = player ?? currentPlayer(table);
  if (p === null || isHandOver(table) || !canAct(p)) return [];

  const owed = toCall(table, p);
  const actions: HoldemAction[] = owed > 0 ? ['fold', 'call'] : ['check'];

  // A raise needs chips beyond the call, and at least one other player who can still
  // act - raising into a table of all-ins is meaningless.
  const othersLive = contenders(table).filter((o) => o.seat !== p.seat && !o.allIn);
  if (p.chips > owed && othersLive.length > 0) {
    actions.push(table.currentBet > 0 ? 'raise' : 'bet');
  }
  return actions;
}

// -------------------------------------------------------------------- side pots --

/**
 * Split contributions into a main pot and any side pots.
 *
 * A folded player's chips still form part of the pot they paid into; they are simply
 * not eligible to win it. That is why this walks *contribution levels* rather than
 * players - it is the only way short stacks and folds compose correctly.
 */
export function buildPots(players: readonly HoldemPlayer[]): Pot[] {
  const contributors = players.filter((p) => p.committed > 0);
  if (contributors.length === 0) return [];

  const levels = [...new Set(contributors.map((p) => p.committed))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;

  for (const level of levels) {
    let amount = 0;
    for (const p of contributors) {
      amount += Math.max(0, Math.min(p.committed, level) - previous);
    }
    const eligible = contributors
      .filter((p) => p.committed >= level && inHand(p))
      .map((p) => p.seat);
    previous = level;
    if (amount <= 0) continue;

    // Consecutive layers contested by exactly the same seats are really one pot.
    // Without this, a player folding their blind would look like it created a side pot.
    const last = pots[pots.length - 1];
    if (last && last.eligible.join(',') === eligible.join(',')) {
      last.amount += amount;
    } else {
      pots.push({ amount, eligible, isSide: pots.length > 0 });
    }
  }
  return pots;
}

// ------------------------------------------------------------------- dealing --

const drawCard = (table: HoldemTable): Card => {
  if (table.deckPosition >= table.deck.length) throw new HoldemError('the deck is empty');
  const card = table.deck[table.deckPosition] as Card;
  table.deckPosition += 1;
  return card;
};

const rotate = <T,>(items: T[], start: number): T[] => [
  ...items.slice(start),
  ...items.slice(0, start),
];

function moveButton(table: HoldemTable): void {
  for (let i = 0; i < table.players.length; i += 1) {
    table.button = (table.button + 1) % table.players.length;
    if (!(table.players[table.button] as HoldemPlayer).sittingOut) return;
  }
}

function post(table: HoldemTable, player: HoldemPlayer, amount: number, label: string): void {
  const posted = Math.min(amount, player.chips);
  player.chips -= posted;
  player.bet += posted;
  player.committed += posted;
  if (player.chips === 0) player.allIn = true;
  table.log.push(`${player.name} posts the ${label} (${posted})`);
}

/** Shuffle up and deal. Blinds are posted automatically. */
export function startHand(table: HoldemTable, deck: Card[]): HoldemTable {
  for (const p of table.players) {
    p.sittingOut = p.chips <= 0;
    p.hole = [];
    p.bet = 0;
    p.committed = 0;
    p.folded = p.sittingOut;
    p.allIn = false;
    p.hasActed = false;
    p.lastAction = '';
    p.wonLast = 0;
  }

  if (seated(table).length < 2) {
    throw new HoldemError('not enough funded players to start a hand');
  }

  table.handNumber += 1;
  table.log = [];
  table.deck = deck;
  table.deckPosition = 0;
  table.board = [];
  table.result = null;
  table.currentBet = 0;
  table.minRaise = table.bigBlind;
  table.street = 'preflop';
  table.handInProgress = true;

  moveButton(table);

  const live = seated(table);
  const count = live.length;
  const buttonPlayer = table.players[table.button] as HoldemPlayer;
  // Heads up the button posts the small blind and acts first preflop; at a full table
  // the small blind is the seat to the button's left.
  const order = count === 2
    ? rotate(live, live.indexOf(buttonPlayer))
    : rotate(live, (live.indexOf(buttonPlayer) + 1) % count);

  post(table, order[0] as HoldemPlayer, table.smallBlind, 'small blind');
  post(table, order[1] as HoldemPlayer, table.bigBlind, 'big blind');
  table.currentBet = table.bigBlind;

  for (const p of live) p.hole = [drawCard(table), drawCard(table)];

  const first = order[2 % count] as HoldemPlayer;
  table.toAct = table.players.indexOf(first);
  skipToActionable(table);
  return table;
}

/** Convenience: shuffle a fresh deck from the fair stream and deal. */
export function dealHand(
  table: HoldemTable,
  draw: { shuffle<T>(items: readonly T[]): T[] },
): HoldemTable {
  return startHand(table, draw.shuffle(freshDeck(1)));
}

// -------------------------------------------------------------------- acting --

function commit(player: HoldemPlayer, amount: number): number {
  const paid = Math.max(0, Math.min(amount, player.chips));
  player.chips -= paid;
  player.bet += paid;
  player.committed += paid;
  if (player.chips === 0) player.allIn = true;
  return paid;
}

function applyRaise(table: HoldemTable, player: HoldemPlayer, requested: number): void {
  const low = minRaiseTo(table, player);
  const high = maxRaiseTo(table, player);
  const target = Math.max(low, Math.min(Math.floor(requested), high));
  const increase = target - table.currentBet;
  commit(player, target - player.bet);

  // An all-in that falls short of a full raise does not reopen betting for players who
  // have already acted - the standard rule, and easy to get wrong.
  const reopens = increase >= table.minRaise;
  if (reopens) table.minRaise = increase;

  const previousBet = table.currentBet;
  table.currentBet = Math.max(table.currentBet, player.bet);

  const verb = previousBet === 0 ? 'bets' : 'raises to';
  player.lastAction = player.allIn
    ? 'All in'
    : `${previousBet === 0 ? 'Bet' : 'Raise'} ${player.bet}`;
  table.log.push(
    `${player.name} ${verb} ${player.bet}${player.allIn ? ' and is all in' : ''}`,
  );

  if (reopens) {
    for (const other of contenders(table)) {
      if (other.seat !== player.seat && !other.allIn) other.hasActed = false;
    }
  }
}

/** Apply an action for the player whose turn it is. */
export function act(table: HoldemTable, action: HoldemAction, amount = 0): HoldemTable {
  const player = currentPlayer(table);
  if (player === null || isHandOver(table)) throw new HoldemError('no action is pending');
  if (!legalActions(table, player).includes(action)) {
    throw new HoldemError(`${action} is not legal here`);
  }

  switch (action) {
    case 'fold':
      player.folded = true;
      player.lastAction = 'Fold';
      table.log.push(`${player.name} folds`);
      break;
    case 'check':
      player.lastAction = 'Check';
      table.log.push(`${player.name} checks`);
      break;
    case 'call': {
      const paid = commit(player, toCall(table, player));
      player.lastAction = player.allIn ? 'All in' : `Call ${paid}`;
      table.log.push(`${player.name} calls ${paid}`);
      break;
    }
    default:
      applyRaise(table, player, amount);
      break;
  }

  player.hasActed = true;
  return afterAction(table);
}

function afterAction(table: HoldemTable): HoldemTable {
  if (contenders(table).length <= 1) return finishWithoutShowdown(table);
  if (bettingComplete(table)) return advanceStreet(table);
  nextPlayer(table);
  return table;
}

function bettingComplete(table: HoldemTable): boolean {
  const actionable = contenders(table).filter((p) => !p.allIn);
  if (actionable.length === 0) return true;
  return actionable.every((p) => p.hasActed && p.bet === table.currentBet);
}

function nextPlayer(table: HoldemTable): void {
  if (table.toAct === null) return;
  for (let step = 1; step <= table.players.length; step += 1) {
    const index = (table.toAct + step) % table.players.length;
    if (canAct(table.players[index] as HoldemPlayer)) {
      table.toAct = index;
      return;
    }
  }
  table.toAct = null;
}

function skipToActionable(table: HoldemTable): void {
  if (table.toAct === null) return;
  if (canAct(table.players[table.toAct] as HoldemPlayer)) return;
  nextPlayer(table);
}

// -------------------------------------------------------------------- streets --

function firstToActPostflop(table: HoldemTable): HoldemPlayer | null {
  const order = seated(table);
  if (order.length === 0) return null;
  const start = (order.indexOf(table.players[table.button] as HoldemPlayer) + 1) % order.length;
  for (let step = 0; step < order.length; step += 1) {
    const candidate = order[(start + step) % order.length] as HoldemPlayer;
    if (canAct(candidate)) return candidate;
  }
  return null;
}

function advanceStreet(table: HoldemTable): HoldemTable {
  for (const p of table.players) {
    p.bet = 0;
    p.hasActed = false;
  }
  table.currentBet = 0;
  table.minRaise = table.bigBlind;

  if (table.street === 'preflop') {
    table.street = 'flop';
    table.board.push(drawCard(table), drawCard(table), drawCard(table));
  } else if (table.street === 'flop') {
    table.street = 'turn';
    table.board.push(drawCard(table));
  } else if (table.street === 'turn') {
    table.street = 'river';
    table.board.push(drawCard(table));
  } else {
    return showdown(table);
  }

  const actionable = contenders(table).filter((p) => !p.allIn);
  if (actionable.length <= 1) {
    // Everyone is committed; run the rest of the board out unattended.
    table.toAct = null;
    return advanceStreet(table);
  }

  const first = firstToActPostflop(table);
  table.toAct = first ? table.players.indexOf(first) : null;
  skipToActionable(table);
  return table;
}

// ------------------------------------------------------------------- settling --

/**
 * Seats in payout order starting immediately left of the button, which is where an
 * odd chip goes when a pot splits unevenly.
 */
function seatsLeftOfButton(table: HoldemTable): number[] {
  const order: number[] = [];
  for (let step = 1; step <= table.players.length; step += 1) {
    order.push((table.button + step) % table.players.length);
  }
  return order;
}

/**
 * Move every committed chip out of the "in front of the player" column once the pots
 * have been built and paid. Without this the same chips sit in both `chips` and
 * `committed`, and `totalChips` silently doubles - which is exactly the shape of the
 * bug that minted 4,918 chips in pysino.
 */
function clearCommitments(table: HoldemTable): void {
  for (const p of table.players) {
    p.bet = 0;
    p.committed = 0;
  }
}

function finishWithoutShowdown(table: HoldemTable): HoldemTable {
  const winner = table.players.find(inHand) ?? null;
  const pots = buildPots(table.players);
  const entries: ShowdownEntry[] = [];

  if (winner) {
    const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
    winner.chips += total;
    winner.wonLast = total;
    entries.push({ seat: winner.seat, rank: null, description: null, won: total });
    table.log.push(`${winner.name} wins ${total} uncontested`);
  }
  clearCommitments(table);

  table.street = 'complete';
  table.toAct = null;
  table.handInProgress = false;
  table.result = {
    winners: winner ? [winner.seat] : [],
    entries,
    pots,
    board: [...table.board],
    wentToShowdown: false,
  };
  return table;
}

function showdown(table: HoldemTable): HoldemTable {
  while (table.board.length < 5) table.board.push(drawCard(table));

  table.toAct = null;
  const live = contenders(table);
  const ranks = new Map<number, HandRank>();
  for (const p of live) ranks.set(p.seat, evaluate([...p.hole, ...table.board]));

  const entries: ShowdownEntry[] = live.map((p) => ({
    seat: p.seat,
    rank: ranks.get(p.seat) as HandRank,
    description: describeRank(ranks.get(p.seat) as HandRank),
    won: 0,
  }));
  const bySeat = new Map(entries.map((e) => [e.seat, e]));
  const payoutOrder = seatsLeftOfButton(table);
  const pots = buildPots(table.players);

  for (const pot of pots) {
    const eligible = pot.eligible.filter((seat) => ranks.has(seat));
    if (eligible.length === 0) continue;

    const best = Math.max(...eligible.map((seat) => (ranks.get(seat) as HandRank).value));
    // Sorted left of the button so the odd chip goes where the rules say it does.
    const winners = payoutOrder.filter(
      (seat) => eligible.includes(seat) && (ranks.get(seat) as HandRank).value === best,
    );

    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount % winners.length;
    winners.forEach((seat, index) => {
      const extra = index < remainder ? 1 : 0;
      const player = table.players[seat] as HoldemPlayer;
      player.chips += share + extra;
      player.wonLast += share + extra;
      (bySeat.get(seat) as ShowdownEntry).won += share + extra;
    });
  }

  clearCommitments(table);

  const overall = Math.max(0, ...entries.map((e) => e.won));
  table.result = {
    winners: entries.filter((e) => e.won === overall && overall > 0).map((e) => e.seat),
    entries,
    pots,
    board: [...table.board],
    wentToShowdown: true,
  };
  for (const entry of entries) {
    if (entry.description) {
      table.log.push(`${(table.players[entry.seat] as HoldemPlayer).name} shows ${entry.description}`);
    }
  }
  table.street = 'complete';
  table.handInProgress = false;
  return table;
}

// ----------------------------------------------------------------------- bots --

/**
 * Probability of winning (ties counted as half) by random simulation.
 *
 * Takes a `CasualSource`. That is the entire point of the type: a `FairSource` will not
 * compile here, so a bot cannot consume draws that belong to the deal.
 */
export function estimateEquity(
  hole: readonly Card[],
  board: readonly Card[],
  opponents: number,
  random: CasualSource,
  iterations = 240,
): number {
  if (opponents <= 0) return 1;

  const known = new Set<Card>([...hole, ...board]);
  const deck = freshDeck(1).filter((card) => !known.has(card));
  const needed = 5 - board.length;
  const draw = needed + 2 * opponents;
  if (draw > deck.length) return 0;

  let score = 0;
  for (let i = 0; i < iterations; i += 1) {
    const sample = random.sample(deck, draw);
    const runout = [...board, ...sample.slice(0, needed)];
    const mine = evaluate([...hole, ...runout]).value;

    let bestOther = -1;
    for (let o = 0; o < opponents; o += 1) {
      const cursor = needed + o * 2;
      const other = evaluate([...sample.slice(cursor, cursor + 2), ...runout]).value;
      if (other > bestOther) bestOther = other;
    }

    if (mine > bestOther) score += 1;
    else if (mine === bestOther) score += 0.5;
  }
  return score / iterations;
}

export interface BotDecision {
  action: HoldemAction;
  amount: number;
  /** Exposed for tests and for the table log; never sent to other players. */
  equity: number;
}

/** Work out what a bot wants to do, without applying it. */
export function botDecision(
  table: HoldemTable,
  random: CasualSource,
  player?: HoldemPlayer,
): BotDecision {
  const p = player ?? currentPlayer(table);
  if (p === null) throw new HoldemError('nobody is to act');

  const profile = p.profile ?? (PROFILES[1] as AIProfile);
  const actions = legalActions(table, p);
  if (actions.length === 0) throw new HoldemError('no legal actions');

  const opponents = Math.max(1, contenders(table).filter((o) => o.seat !== p.seat).length);
  const equity = estimateEquity(p.hole, table.board, opponents, random, profile.iterations);

  const owed = toCall(table, p);
  const pot = potOf(table);
  const potOdds = owed > 0 ? owed / (pot + owed) : 0;
  const roll = random.nextFloat();

  // Scale the raw simulation result by how willing this bot is to commit.
  const confidence = equity - (profile.tightness - 0.5) * 0.25;

  if (owed === 0) {
    const wantsValue = confidence > 0.58 && roll < 0.35 + profile.aggression;
    const wantsBluff = confidence < 0.35 && roll < profile.bluff;
    const canOpen = actions.includes('bet') || actions.includes('raise');
    if ((wantsValue || wantsBluff) && canOpen) {
      const sizing = 0.5 + profile.aggression * 0.5;
      const target = Math.max(minRaiseTo(table, p), Math.floor(pot * sizing));
      return {
        action: actions.includes('bet') ? 'bet' : 'raise',
        amount: Math.min(target, maxRaiseTo(table, p)),
        equity,
      };
    }
    return { action: 'check', amount: 0, equity };
  }

  if (confidence < potOdds - 0.02) {
    // Priced out - though a tiny call against a big pot is still fine.
    const cheap = owed <= p.chips * 0.03 && confidence > 0.2;
    if (!cheap && roll > profile.bluff) return { action: 'fold', amount: 0, equity };
  }

  const canRaise = actions.includes('raise') || actions.includes('bet');
  if (confidence > 0.72 && roll < profile.aggression + 0.25 && canRaise) {
    const sizing = 0.6 + profile.aggression * 0.6;
    const target = Math.max(minRaiseTo(table, p), Math.floor((pot + owed) * sizing));
    return {
      action: actions.includes('raise') ? 'raise' : 'bet',
      amount: Math.min(target, maxRaiseTo(table, p)),
      equity,
    };
  }

  if (actions.includes('call')) return { action: 'call', amount: 0, equity };
  return actions.includes('check')
    ? { action: 'check', amount: 0, equity }
    : { action: 'fold', amount: 0, equity };
}

/** Decide and apply, for a seat the table is waiting on. */
export function playBotTurn(table: HoldemTable, random: CasualSource): BotDecision {
  const decision = botDecision(table, random);
  act(table, decision.action, decision.amount);
  return decision;
}

/** Seat a human plus `botCount` bots with distinct personalities and names. */
export function makeTable(
  random: CasualSource,
  humanStack: number,
  botCount = 3,
  botStack = 2_000,
  humanName = 'You',
): HoldemPlayer[] {
  const profiles = random.shuffle(PROFILES);
  const names = random.shuffle(BOT_NAMES);
  const players = [makePlayer(0, humanName, humanStack)];
  for (let i = 0; i < botCount; i += 1) {
    players.push(makePlayer(
      i + 1,
      names[i % names.length] as string,
      botStack,
      profiles[i % profiles.length] as AIProfile,
    ));
  }
  return players;
}
