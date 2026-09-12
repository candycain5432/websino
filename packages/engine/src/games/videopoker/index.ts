/**
 * Jacks or Better video poker on the classic 9/6 paytable.
 *
 * Nine for a full house and six for a flush is the full-pay schedule, worth about 99.5%
 * to a perfect player - comfortably the best value in the building. Five cards are dealt,
 * the player holds any subset, and the rest are replaced **from the same deck**.
 *
 * **Fairness draw order.** One `shuffle()` of a 52-card deck at `deal`. The hand is the
 * first five cards and replacements come from position 5 onward, so the whole round -
 * deal *and* draw - is fixed before the player chooses what to hold. That matters: it is
 * what stops the replacements from being chosen after seeing the holds, and it means one
 * `(serverSeed, clientSeed, nonce)` replays the entire hand.
 *
 * The royal flush jumps from 250 to 800 per coin at five coins, which is the only reason
 * to ever bet max - and the reason the paytable is indexed by coins rather than scaled.
 */

import type { FairSource } from '@websino/fair';

import { type Card, freshDeck } from '../../cards.js';
import * as poker from '../../handEval.js';
import { combinations } from '../../util/combinatorics.js';

export const MAX_COINS = 5;
export const HAND_SIZE = 5;

export const ROYAL_FLUSH = 'royal_flush';
export const STRAIGHT_FLUSH = 'straight_flush';
export const FOUR_OF_A_KIND = 'four_of_a_kind';
export const FULL_HOUSE = 'full_house';
export const FLUSH = 'flush';
export const STRAIGHT = 'straight';
export const THREE_OF_A_KIND = 'three_of_a_kind';
export const TWO_PAIR = 'two_pair';
export const JACKS_OR_BETTER = 'jacks_or_better';

export type PayingHand =
  | typeof ROYAL_FLUSH | typeof STRAIGHT_FLUSH | typeof FOUR_OF_A_KIND
  | typeof FULL_HOUSE | typeof FLUSH | typeof STRAIGHT
  | typeof THREE_OF_A_KIND | typeof TWO_PAIR | typeof JACKS_OR_BETTER;

export const HAND_NAMES: Record<PayingHand, string> = {
  [ROYAL_FLUSH]: 'Royal Flush',
  [STRAIGHT_FLUSH]: 'Straight Flush',
  [FOUR_OF_A_KIND]: 'Four of a Kind',
  [FULL_HOUSE]: 'Full House',
  [FLUSH]: 'Flush',
  [STRAIGHT]: 'Straight',
  [THREE_OF_A_KIND]: 'Three of a Kind',
  [TWO_PAIR]: 'Two Pair',
  [JACKS_OR_BETTER]: 'Jacks or Better',
};

/** Payout per coin wagered, indexed by coins played (1-5). */
export const PAYTABLE: Record<PayingHand, readonly number[]> = {
  [ROYAL_FLUSH]: [250, 500, 750, 1000, 4000],
  [STRAIGHT_FLUSH]: [50, 100, 150, 200, 250],
  [FOUR_OF_A_KIND]: [25, 50, 75, 100, 125],
  [FULL_HOUSE]: [9, 18, 27, 36, 45],
  [FLUSH]: [6, 12, 18, 24, 30],
  [STRAIGHT]: [4, 8, 12, 16, 20],
  [THREE_OF_A_KIND]: [3, 6, 9, 12, 15],
  [TWO_PAIR]: [2, 4, 6, 8, 10],
  [JACKS_OR_BETTER]: [1, 2, 3, 4, 5],
};

/** Display order, best first. */
export const PAY_ORDER: readonly PayingHand[] = [
  ROYAL_FLUSH, STRAIGHT_FLUSH, FOUR_OF_A_KIND, FULL_HOUSE, FLUSH,
  STRAIGHT, THREE_OF_A_KIND, TWO_PAIR, JACKS_OR_BETTER,
];

export type VideoPokerPhase = 'holding' | 'complete';

export class VideoPokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoPokerError';
  }
}

export interface VideoPokerRound {
  /** The full shuffled deck. Positions 5+ are the undealt replacements. */
  deck: Card[];
  cards: Card[];
  held: boolean[];
  coins: number;
  coinValue: number;
  /** Next deck position to draw a replacement from. */
  position: number;
  drawn: number[];
  result: PayingHand | null;
  payout: number;
  phase: VideoPokerPhase;
}

/** Name the paying hand, or `null` when it misses entirely. */
export function classify(cards: readonly Card[]): PayingHand | null {
  if (cards.length !== HAND_SIZE) {
    throw new VideoPokerError('video poker hands are exactly five cards');
  }
  const rank = poker.evaluate(cards);
  switch (rank.category) {
    case poker.STRAIGHT_FLUSH:
      // Rank 12 is an ace, so an ace-high straight flush is the royal.
      return rank.tiebreakers[0] === 12 ? ROYAL_FLUSH : STRAIGHT_FLUSH;
    case poker.FOUR_OF_A_KIND: return FOUR_OF_A_KIND;
    case poker.FULL_HOUSE: return FULL_HOUSE;
    case poker.FLUSH: return FLUSH;
    case poker.STRAIGHT: return STRAIGHT;
    case poker.THREE_OF_A_KIND: return THREE_OF_A_KIND;
    case poker.TWO_PAIR: return TWO_PAIR;
    // Rank 9 is a jack, so pairs of jacks or better pay and lower pairs do not.
    case poker.PAIR: return (rank.tiebreakers[0] as number) >= 9 ? JACKS_OR_BETTER : null;
    default: return null;
  }
}

export function payoutForHand(hand: PayingHand | null, coins: number, coinValue: number): number {
  if (hand === null) return 0;
  const clamped = Math.max(1, Math.min(MAX_COINS, coins));
  return (PAYTABLE[hand][clamped - 1] as number) * coinValue;
}

export const betFor = (coins: number, coinValue: number): number => coins * coinValue;

export function deal(coins: number, coinValue: number, draw: FairSource): VideoPokerRound {
  if (!Number.isInteger(coins) || coins < 1 || coins > MAX_COINS) {
    throw new VideoPokerError(`coins must be 1-${MAX_COINS}`);
  }
  if (!Number.isInteger(coinValue) || coinValue < 1) {
    throw new VideoPokerError('coin value must be a positive whole number');
  }
  const deck = draw.shuffle(freshDeck(1));
  return {
    deck,
    cards: deck.slice(0, HAND_SIZE),
    held: Array<boolean>(HAND_SIZE).fill(false),
    coins,
    coinValue,
    position: HAND_SIZE,
    drawn: [],
    result: null,
    payout: 0,
    phase: 'holding',
  };
}

export function setHolds(round: VideoPokerRound, mask: readonly boolean[]): VideoPokerRound {
  if (round.phase !== 'holding') throw new VideoPokerError('no hand to hold');
  if (mask.length !== HAND_SIZE) throw new VideoPokerError('hold mask must cover five cards');
  return { ...round, held: mask.map(Boolean) };
}

/** Replace every unheld card from the same deck and settle. */
export function drawCards(round: VideoPokerRound): VideoPokerRound {
  if (round.phase !== 'holding') throw new VideoPokerError('nothing to draw');

  const cards = [...round.cards];
  const drawn: number[] = [];
  let position = round.position;
  for (let index = 0; index < HAND_SIZE; index += 1) {
    if (round.held[index]) continue;
    cards[index] = round.deck[position] as Card;
    position += 1;
    drawn.push(index);
  }

  const result = classify(cards);
  return {
    ...round,
    cards,
    position,
    drawn,
    result,
    payout: payoutForHand(result, round.coins, round.coinValue),
    phase: 'complete',
  };
}

// ---------------------------------------------------------------------- hint --

/** Above this many possible draws, sample instead of enumerating. */
const EXACT_LIMIT = 3000;

/**
 * Expected payout in coins-per-coin for keeping `held`.
 *
 * Takes an explicit `random` for the sampled branch. That parameter is the whole point:
 * it is a plain `() => number`, so the fair stream *cannot* be passed here. pysino's
 * equivalent drew from the same generator as the deal, which meant pressing the hint
 * button changed the cards it was about to deal.
 */
function holdEV(
  held: readonly Card[],
  remaining: readonly Card[],
  draws: number,
  random: () => number,
  samples: number,
): number {
  if (draws === 0) {
    const hand = classify(held);
    return hand ? (PAYTABLE[hand][0] as number) : 0;
  }

  let total = 0;
  let count = 0;

  // C(47, k) is 47, 1081 and 16215 for k = 1, 2, 3 - so one and two card draws
  // enumerate exactly and the wider ones sample.
  const exact = draws <= 2;
  if (exact) {
    for (const extra of combinations(remaining, draws)) {
      const hand = classify([...held, ...extra]);
      total += hand ? (PAYTABLE[hand][0] as number) : 0;
      count += 1;
    }
  } else {
    for (let i = 0; i < samples; i += 1) {
      const pool = [...remaining];
      const extra: Card[] = [];
      for (let d = 0; d < draws; d += 1) {
        const pick = Math.floor(random() * pool.length);
        extra.push(pool[pick] as Card);
        pool.splice(pick, 1);
      }
      const hand = classify([...held, ...extra]);
      total += hand ? (PAYTABLE[hand][0] as number) : 0;
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * Suggest which cards to keep, scoring all 32 hold patterns.
 *
 * `random` defaults to `Math.random` and is never the fair stream - see `holdEV`.
 */
export function bestHold(
  cards: readonly Card[],
  random: () => number = Math.random,
  samples = 800,
): boolean[] {
  if (cards.length !== HAND_SIZE) throw new VideoPokerError('need a five card hand');
  const seen = new Set(cards);
  const remaining = freshDeck(1).filter((card) => !seen.has(card));

  let bestMask: boolean[] = [false, false, false, false, false];
  let bestValue = -1;

  for (let pattern = 0; pattern < 32; pattern += 1) {
    const mask = Array.from({ length: HAND_SIZE }, (_, i) => Boolean(pattern & (1 << i)));
    const held = cards.filter((_, i) => mask[i]);
    const value = holdEV(held, remaining, HAND_SIZE - held.length, random, samples);
    if (value > bestValue) {
      bestMask = mask;
      bestValue = value;
    }
  }
  return bestMask;
}

export const EXACT_DRAW_LIMIT = EXACT_LIMIT;
