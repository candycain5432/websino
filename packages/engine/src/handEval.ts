/**
 * Poker hand evaluation for five to seven cards.
 *
 * Ported from pysino's core/poker.py, which was verified category-by-category
 * including the wheel straight and the "five spades plus a separate straight" trap.
 * Operates on packed card integers, so ranks and suits are plain arithmetic.
 *
 * The result packs down to a single integer so hold'em's Monte Carlo bots can compare
 * thousands of rollouts with `>` instead of tuple comparison.
 */

import { type Card, rankOf, suitOf, SUITS } from './cards.js';

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const THREE_OF_A_KIND = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const FOUR_OF_A_KIND = 7;
export const STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES: Record<number, string> = {
  [HIGH_CARD]: 'High Card',
  [PAIR]: 'Pair',
  [TWO_PAIR]: 'Two Pair',
  [THREE_OF_A_KIND]: 'Three of a Kind',
  [STRAIGHT]: 'Straight',
  [FLUSH]: 'Flush',
  [FULL_HOUSE]: 'Full House',
  [FOUR_OF_A_KIND]: 'Four of a Kind',
  [STRAIGHT_FLUSH]: 'Straight Flush',
};

const PLURALS = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines',
  'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
] as const;

const SINGULAR = [
  '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A',
] as const;

/** Tiebreakers are packed base-15 (ranks reach 12), five deep. */
const PACK_BASE = 15;
const PACK_WIDTH = 5;

export interface HandRank {
  category: number;
  /** Descending significance. Ranks are 0..12 where 12 is an ace. */
  tiebreakers: number[];
  /** The five cards that made the hand, for highlighting in the UI. */
  cards: Card[];
  /** Single integer encoding category + kickers. Larger is better. */
  value: number;
}

function pack(category: number, tiebreakers: readonly number[]): number {
  let packed = category;
  for (let i = 0; i < PACK_WIDTH; i += 1) {
    packed = packed * PACK_BASE + (tiebreakers[i] ?? 0);
  }
  return packed;
}

/**
 * Highest card of the best straight present, or -1 for none.
 * Aces play low as well as high, so a wheel (A-2-3-4-5) reports a high of 3 (a five).
 */
function straightHigh(ranks: ReadonlySet<number>): number {
  // The lowest ace-high straight runs 2..6, i.e. ranks 0..4, so 4 is the lowest
  // `high` a normal straight can have.
  for (let high = 12; high >= 4; high -= 1) {
    if (
      ranks.has(high) &&
      ranks.has(high - 1) &&
      ranks.has(high - 2) &&
      ranks.has(high - 3) &&
      ranks.has(high - 4)
    ) {
      return high;
    }
  }
  // The wheel: A,5,4,3,2 - the ace (rank 12) plays below the two (rank 0). Reported
  // as high = 3 (the five), which no ordinary straight can produce, so the value is
  // unambiguous and sorts below every other straight.
  if (ranks.has(12) && ranks.has(0) && ranks.has(1) && ranks.has(2) && ranks.has(3)) return 3;
  return -1;
}

/** Pick one card per rank making up the straight ending at `high`. */
function straightCards(cards: readonly Card[], high: number): Card[] {
  const wanted = high === 3 ? [3, 2, 1, 0, 12] : [high, high - 1, high - 2, high - 3, high - 4];
  const byRank = new Map<number, Card>();
  for (const card of cards) {
    if (!byRank.has(rankOf(card))) byRank.set(rankOf(card), card);
  }
  return wanted.map((r) => byRank.get(r) as Card);
}

export function evaluate(cards: readonly Card[]): HandRank {
  if (cards.length < 5) throw new Error('need at least five cards to evaluate a poker hand');

  const rankCounts = new Map<number, number>();
  const suitCounts = new Array<number>(SUITS).fill(0);
  for (const card of cards) {
    const r = rankOf(card);
    rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
    const s = suitOf(card);
    suitCounts[s] = (suitCounts[s] ?? 0) + 1;
  }

  const flushSuit = suitCounts.findIndex((n) => n >= 5);
  const make = (category: number, tiebreakers: number[], made: Card[]): HandRank => ({
    category,
    tiebreakers,
    cards: made,
    value: pack(category, tiebreakers),
  });

  let flushCards: Card[] = [];
  if (flushSuit >= 0) {
    flushCards = cards
      .filter((c) => suitOf(c) === flushSuit)
      .sort((a, b) => rankOf(b) - rankOf(a));
    const high = straightHigh(new Set(flushCards.map(rankOf)));
    if (high >= 0) {
      return make(STRAIGHT_FLUSH, [high], straightCards(flushCards, high));
    }
  }

  // Sort ranks by count first, then by rank: quads and trips float to the front and
  // kickers come out in descending order for free.
  const ordered = [...rankCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = ordered.map(([, count]) => count);
  const cardsOf = (rank: number, limit: number): Card[] =>
    cards.filter((c) => rankOf(c) === rank).slice(0, limit);

  if (shape[0] === 4) {
    const quad = ordered[0]![0];
    const kicker = Math.max(...[...rankCounts.keys()].filter((r) => r !== quad));
    return make(FOUR_OF_A_KIND, [quad, kicker], [...cardsOf(quad, 4), ...cardsOf(kicker, 1)]);
  }

  if (shape[0] === 3 && (shape[1] ?? 0) >= 2) {
    const trips = ordered[0]![0];
    const pair = Math.max(...ordered.slice(1).filter(([, c]) => c >= 2).map(([r]) => r));
    return make(FULL_HOUSE, [trips, pair], [...cardsOf(trips, 3), ...cardsOf(pair, 2)]);
  }

  if (flushSuit >= 0) {
    const best = flushCards.slice(0, 5);
    return make(FLUSH, best.map(rankOf), best);
  }

  const high = straightHigh(new Set(rankCounts.keys()));
  if (high >= 0) return make(STRAIGHT, [high], straightCards(cards, high));

  if (shape[0] === 3) {
    const trips = ordered[0]![0];
    const kickers = [...rankCounts.keys()].filter((r) => r !== trips).sort((a, b) => b - a).slice(0, 2);
    return make(
      THREE_OF_A_KIND,
      [trips, ...kickers],
      [...cardsOf(trips, 3), ...kickers.map((r) => cardsOf(r, 1)[0] as Card)],
    );
  }

  const pairs = [...rankCounts.entries()].filter(([, c]) => c === 2).map(([r]) => r).sort((a, b) => b - a);

  if (pairs.length >= 2) {
    const [hi, lo] = pairs as [number, number];
    const kicker = Math.max(...[...rankCounts.keys()].filter((r) => r !== hi && r !== lo));
    return make(
      TWO_PAIR,
      [hi, lo, kicker],
      [...cardsOf(hi, 2), ...cardsOf(lo, 2), ...cardsOf(kicker, 1)],
    );
  }

  if (pairs.length === 1) {
    const pair = pairs[0] as number;
    const kickers = [...rankCounts.keys()].filter((r) => r !== pair).sort((a, b) => b - a).slice(0, 3);
    return make(
      PAIR,
      [pair, ...kickers],
      [...cardsOf(pair, 2), ...kickers.map((r) => cardsOf(r, 1)[0] as Card)],
    );
  }

  const best = [...cards].sort((a, b) => rankOf(b) - rankOf(a)).slice(0, 5);
  return make(HIGH_CARD, best.map(rankOf), best);
}

/** `1` if left wins, `-1` if right wins, `0` on a split. */
export function compare(left: readonly Card[], right: readonly Card[]): number {
  const a = evaluate(left).value;
  const b = evaluate(right).value;
  return a > b ? 1 : a < b ? -1 : 0;
}

export function describe(rank: HandRank): string {
  const t = rank.tiebreakers;
  const plural = (r: number): string => PLURALS[r] as string;
  const single = (r: number): string => SINGULAR[r] as string;

  switch (rank.category) {
    case STRAIGHT_FLUSH:
      return t[0] === 12 ? 'Royal Flush' : `Straight Flush, ${single(t[0] as number)} high`;
    case FOUR_OF_A_KIND:
      return `Four ${plural(t[0] as number)}`;
    case FULL_HOUSE:
      return `${plural(t[0] as number)} full of ${plural(t[1] as number)}`;
    case FLUSH:
      return `Flush, ${single(t[0] as number)} high`;
    case STRAIGHT:
      return `Straight, ${single(t[0] as number)} high`;
    case THREE_OF_A_KIND:
      return `Three ${plural(t[0] as number)}`;
    case TWO_PAIR:
      return `Two Pair, ${plural(t[0] as number)} and ${plural(t[1] as number)}`;
    case PAIR:
      return `Pair of ${plural(t[0] as number)}`;
    default:
      return `${single(t[0] as number)} high`;
  }
}
