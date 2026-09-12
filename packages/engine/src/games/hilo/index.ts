/**
 * Hi-Lo: see a card, guess whether the next one is higher or lower, repeat.
 *
 * Every card is drawn independently from a full 52-card deck - the deck is never
 * depleted. That is a real design decision rather than a shortcut: with a depleting deck
 * the odds depend on every card seen so far, which means the player cannot check the
 * quoted multiplier without replaying the whole round, and the game can simply run out
 * of cards mid-streak. Drawing fresh every time makes the odds a function of the one
 * card on the table, which is a game a player can actually reason about.
 *
 * **Fairness draw order.** `MAX_STEPS + 1` calls to `randBelow(52)` at `start`, all of
 * them, before the player has done anything. The run is laid out up front exactly the
 * way mines lays its board, and for the same two reasons: the number of draws a round
 * consumes never depends on how the player played it, and no request after the first
 * has to resume a stream from a stored position. Cards stay secret until the guess that
 * turns them over.
 *
 * **Ties.** The two choices are *higher or the same* and *lower or the same*, so a pair
 * pays out on either. The alternative - a third "same" outcome that loses - means the
 * player is quietly paying for an event neither button covers, and their probabilities
 * would not sum to 1. Here they overlap on equality instead, and each is priced honestly
 * for what it actually covers.
 */

import { DECK_SIZE, RANKS, rankOf, type Card } from '../../cards.js';
import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import type { FairSource } from '@websino/fair';

export type HiLoGuess = 'higher' | 'lower';
export type HiLoState = 'playing' | 'busted' | 'cashed';

/** A streak longer than this is capped, to keep the multiplier finite and the UI sane. */
export const MAX_STEPS = 20;

export class HiLoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HiLoError';
  }
}

export interface HiLoStep {
  guess: HiLoGuess;
  card: Card;
  won: boolean;
  /** The multiplier for this step alone, before compounding. */
  stepMultiplier: number;
}

export interface HiLoRound {
  bet: number;
  /**
   * Every card the round could ever turn over, drawn at `start`.
   *
   * Secret: index 0 is the opening card and is public from the off, but the rest are
   * the future and must never leave the server until they are turned over.
   */
  cards: Card[];
  history: HiLoStep[];
  state: HiLoState;
  /** Compounded multiplier over every winning step so far. */
  multiplier: number;
}

/** The card the next guess is measured against. */
export const currentCard = (round: HiLoRound): Card =>
  round.cards[round.history.length] as Card;

/**
 * How many of the thirteen ranks satisfy a guess against `card`.
 *
 * Ranks, not cards: a fresh 52-card deck makes every rank equally likely, so counting
 * ranks and counting cards give the same probability and ranks are easier to check by
 * hand - which is the point of quoting odds at all.
 */
export function winningRanks(card: Card, guess: HiLoGuess): number {
  const rank = rankOf(card);
  return guess === 'higher' ? RANKS - rank : rank + 1;
}

export const winChance = (card: Card, guess: HiLoGuess): number =>
  winningRanks(card, guess) / RANKS;

/**
 * What one correct guess pays.
 *
 * `(1 - edge) / chance`, the same identity every other game here uses, so a guess that
 * is nearly certain pays nearly nothing and a guess against an ace pays about 12.9x.
 * A guaranteed guess - higher-or-same against a two - pays 0.99x, which is a real and
 * deliberate consequence: taking the free step still costs the edge.
 */
export function stepMultiplier(card: Card, guess: HiLoGuess): number {
  const chance = winChance(card, guess);
  if (chance <= 0) return 0;
  return (1 - HOUSE_EDGE) / chance;
}

/** Whether `next` satisfies the guess made against `previous`. Equality pays both ways. */
export const guessWins = (previous: Card, next: Card, guess: HiLoGuess): boolean =>
  guess === 'higher' ? rankOf(next) >= rankOf(previous) : rankOf(next) <= rankOf(previous);

/** What cashing out right now would return, stake included. */
export function currentPayout(round: HiLoRound): number {
  if (round.state === 'busted') return 0;
  if (round.history.length === 0) return round.bet;
  return payoutFor(round.bet, round.multiplier);
}

export const isCapped = (round: HiLoRound): boolean => round.history.length >= MAX_STEPS;

export function startHiLo(bet: number, draw: FairSource): HiLoRound {
  if (!Number.isInteger(bet) || bet <= 0) throw new HiLoError('bet must be positive');
  return {
    bet,
    // One opening card plus one for every step the round could reach.
    cards: Array.from({ length: MAX_STEPS + 1 }, () => draw.randBelow(DECK_SIZE) as Card),
    history: [],
    state: 'playing',
    multiplier: 1,
  };
}

/** Guess, turn over the next card, and settle that one step. */
export function guess(round: HiLoRound, choice: HiLoGuess): HiLoRound {
  if (round.state !== 'playing') throw new HiLoError('no round in play');
  if (choice !== 'higher' && choice !== 'lower') throw new HiLoError('guess must be higher or lower');
  if (isCapped(round)) throw new HiLoError(`a streak cannot run past ${MAX_STEPS} steps`);

  const from = currentCard(round);
  const step = stepMultiplier(from, choice);
  const card = round.cards[round.history.length + 1] as Card;
  const won = guessWins(from, card, choice);

  const history = [...round.history, { guess: choice, card, won, stepMultiplier: step }];
  if (!won) return { ...round, history, state: 'busted', multiplier: 0 };

  const next: HiLoRound = { ...round, history, multiplier: round.multiplier * step };
  // Hitting the cap cashes out where it stands rather than stranding the round.
  return isCapped(next) ? { ...next, state: 'cashed' } : next;
}

export function cashOut(round: HiLoRound): HiLoRound {
  if (round.state === 'cashed') return round;
  if (round.state !== 'playing') throw new HiLoError('nothing to cash out');
  if (round.history.length === 0) throw new HiLoError('make at least one guess before cashing out');
  return { ...round, state: 'cashed' };
}
