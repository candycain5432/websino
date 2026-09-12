/**
 * The shapes stateful games put on the wire.
 *
 * These live in the engine rather than in the server so that the client imports the
 * *same* declarations the server satisfies. Duplicating them on both sides would compile
 * fine right up until a field was renamed on one side only, and the failure would land in
 * a running game rather than in `tsc`.
 *
 * Every one of these is a **redacted** view. A field that is absent is absent because the
 * player has not earned it yet - the hole card while it is face down, the crash point
 * while the curve is still climbing. Nothing here is merely hidden from the UI.
 */

import type { Card } from './cards.js';
import type { Action, Outcome, Phase } from './games/blackjack/index.js';
import type { CrashState } from './games/crash/index.js';

export interface BlackjackHandView {
  cards: Card[];
  bet: number;
  doubled: boolean;
  fromSplit: boolean;
  label: string;
  total: number;
  outcome: Outcome | null;
  payout: number;
}

export interface BlackjackView {
  phase: Phase;
  hands: BlackjackHandView[];
  /** One card while the hole card is down; both once it is turned. */
  dealer: Card[];
  /** Null while the hole card is down - the total would give it away. */
  dealerTotal: number | null;
  holeHidden: boolean;
  activeIndex: number;
  actions: Action[];
  insuranceOffered: boolean;
  insuranceCost: number;
  insuranceBet: number;
  insurancePayout: number;
  staked: number;
  returned: number;
  balance: number;
  cardsRemaining: number;
  proof: { serverSeedHash: string; nonce: number };
}

export interface CrashView {
  state: CrashState;
  bet: number;
  autoCashOut: number | null;
  /** Server time the round began, so the client can draw the same curve. */
  startedAt: number;
  tickMs: number;
  balance: number;
  /** Present only once the round is over - this is the secret. */
  crashPoint?: number;
  cashedMultiplier?: number | null;
  payout?: number;
}

export interface MinesView {
  state: 'playing' | 'busted' | 'cashed';
  bet: number;
  mines: number;
  revealed: number[];
  picks: number;
  multiplier: number;
  /** What cashing out right now would return. */
  payout: number;
  /** What one more safe tile would be worth, or null if the board is clear. */
  nextMultiplier: number | null;
  balance: number;
  /** Absent while the round is live - this is the map. */
  minePositions?: number[];
  hitPosition?: number | null;
  proof: { serverSeedHash: string; nonce: number };
}

/**
 * Hi-Lo, as one player is allowed to see it.
 *
 * `cards` on the round is the whole run drawn up front; what ships here is only the card
 * on the table and the ones already turned over. The future is absent, not hidden.
 */
export interface HiLoView {
  state: 'playing' | 'busted' | 'cashed';
  bet: number;
  /**
   * The card the run opened on.
   *
   * Sent explicitly because it is the only revealed card that is not in `history` -
   * nothing was guessed to turn it over. Without it the opening card simply disappears
   * from the screen after the first guess, and the player loses sight of what they had
   * been guessing against.
   */
  opening: Card;
  /** The card the next guess is measured against. */
  current: Card;
  history: Array<{ guess: 'higher' | 'lower'; card: Card; won: boolean; stepMultiplier: number }>;
  steps: number;
  multiplier: number;
  /** What cashing out right now would return. */
  payout: number;
  /** What each guess would pay, and how likely it is - quoted before the player commits. */
  odds: {
    higher: { chance: number; multiplier: number };
    lower: { chance: number; multiplier: number };
  };
  /** True once the streak has run as far as the game allows. */
  capped: boolean;
  maxSteps: number;
  balance: number;
  proof: { serverSeedHash: string; nonce: number };
}

/**
 * Towers, as one player is allowed to see it.
 *
 * The trap map is absent while the round is live, for the same reason mines' is.
 */
export interface TowersView {
  state: 'playing' | 'busted' | 'cashed';
  bet: number;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert' | 'master';
  tiles: number;
  traps: number;
  rows: number;
  /** The tile picked on each cleared row, bottom first. */
  picks: number[];
  multiplier: number;
  payout: number;
  /** What clearing one more row would be worth, or null at the top. */
  nextMultiplier: number | null;
  /** Every rung's multiplier, so the ladder can be drawn before it is climbed. */
  table: number[];
  balance: number;
  /** Absent while the round is live - this is the map. */
  trapMap?: number[][];
  hit?: { row: number; tile: number } | null;
  proof: { serverSeedHash: string; nonce: number };
}

export interface VideoPokerView {
  phase: 'holding' | 'complete';
  cards: Card[];
  held: boolean[];
  coins: number;
  coinValue: number;
  bet: number;
  drawn: number[];
  result: string | null;
  resultName: string | null;
  payout: number;
  balance: number;
  proof: { serverSeedHash: string; nonce: number };
}

export interface HoldemSeatView {
  seat: number;
  name: string;
  chips: number;
  isBot: boolean;
  /** The bot's playing style, so a seat shows both who and how. */
  style: string | null;
  /** Absent while the hand is live for anyone but you - these are the hole cards. */
  hole?: Card[];
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  lastAction: string;
  wonLast: number;
  isButton: boolean;
  isTurn: boolean;
  /** Shown only at showdown. */
  handDescription?: string | null;
}

export interface HoldemView {
  street: string;
  board: Card[];
  pot: number;
  currentBet: number;
  seats: HoldemSeatView[];
  /** The seat you are sitting in. */
  you: number;
  toAct: number | null;
  yourTurn: boolean;
  actions: string[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  handInProgress: boolean;
  handNumber: number;
  log: string[];
  result: {
    wentToShowdown: boolean;
    winners: number[];
    pots: Array<{ amount: number; eligible: number[]; isSide: boolean }>;
    /** What the house took from this hand. Shown, not hidden - it is the player's cost. */
    rake: number;
  } | null;
  balance: number;
  proof: { serverSeedHash: string; nonce: number };
}

// -------------------------------------------------------------- shared tables --

/**
 * A shared hold'em table as one viewer is allowed to see it.
 *
 * Lives here, next to every other wire DTO, for the reason the whole file exists: the
 * server builds these and the client renders them, so a renamed field has to fail
 * `tsc` on both sides rather than turn into `undefined` at runtime.
 *
 * Redaction is by absence. `hole` is missing - not blanked, not nulled - for every seat
 * the viewer has not earned sight of, so there is nothing in the payload for a patched
 * client to reveal.
 */
export interface RoomSeatView {
  seat: number;
  occupied: boolean;
  kind: 'human' | 'bot' | null;
  /** Stable while the same occupant holds the seat; changes when a bot is replaced. */
  occupantId: string | null;
  name: string;
  style: string | null;
  connected: boolean;
  chips: number;
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  waiting: boolean;
  /** Asked to stand up; it happens as soon as the current hand finishes. */
  leaving: boolean;
  lastAction: string;
  wonLast: number;
  isButton: boolean;
  isTurn: boolean;
  /** Present for your own seat, and for everyone still in at a showdown. */
  hole?: Card[];
  handDescription?: string | null;
}

export interface RoomView {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  street: string;
  board: Card[];
  pot: number;
  seats: RoomSeatView[];
  /** Your seat, or null if you are only watching. */
  you: number | null;
  toAct: number | null;
  yourTurn: boolean;
  actions: string[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  /** Epoch ms the current turn expires - every client counts to the same instant. */
  deadline: number | null;
  turnMs: number;
  nextHandAt: number | null;
  handInProgress: boolean;
  handNumber: number;
  handsPlayed: number;
  log: string[];
  result: { wentToShowdown: boolean; winners: number[]; rake: number } | null;
  balance: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  seated: number;
  humans: number;
  seats: number;
  handsPlayed: number;
}
