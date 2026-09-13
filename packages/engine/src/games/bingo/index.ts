/**
 * Bingo: 75 balls, a 5x5 card with a free centre, and one ball sequence for everybody.
 *
 * **Shared round, fixed odds.** The social part is that every player in a round watches
 * the *same* balls come out; the paying part is that each card is settled on its own
 * merit against a fixed table. That combination is deliberate, and it is not how a real
 * bingo hall works - a hall pools the card sales and splits them among the winners.
 * Pari-mutuel was the first design here and it is wrong for this casino twice over: a
 * round with one player becomes a 1% fee for watching balls, and every player who joins
 * makes everyone else's share smaller, so the other people at the table are opponents.
 * Fixed odds mean a round is a real game when you are alone at two in the morning, and
 * somebody else joining costs you nothing.
 *
 * **The payout depends on how fast your card completes a line.** Fifty balls are drawn;
 * a card that completes inside twenty pays 10x, one that scrapes in at ball fifty pays
 * 0.4x, and one that never completes pays nothing. Roughly four cards in five get
 * something back, and the money is in an early line.
 *
 * **Fairness draw order.** The card: one `sample(15, 5)` per column, columns left to
 * right - so a card costs five draws of five. The balls: one `shuffle(75)` of the whole
 * pool, of which the first fifty are called. Cards come off each buyer's own stream, so
 * your card is yours to verify; the ball sequence comes off the stream of whoever opened
 * the round, the same way a hold'em shuffle is anchored on a seated human rather than on
 * nobody.
 *
 * **The odds are computed, not sampled** - see `exactOdds`. A 5x5 card has twelve lines
 * that overlap, so "when does the first one complete" is an inclusion-exclusion over
 * 4,095 subsets. That is instant, and it means bingo is held to the same standard as
 * every other game here rather than being tuned by feel.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';

export const CARD_SIZE = 5;
export const POOL = 75;
/** Balls called each round. Everything after this is never drawn. */
export const BALLS_DRAWN = 50;
/** Numbers per column: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75. */
export const COLUMN_RANGE = POOL / CARD_SIZE;
export const COLUMN_LETTERS = ['B', 'I', 'N', 'G', 'O'] as const;

/** The free square, as `[row, column]`. */
export const FREE_CELL: readonly [number, number] = [2, 2];

export const MIN_CARDS = 1;
export const MAX_CARDS = 4;

export class BingoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BingoError';
  }
}

/**
 * A card as `numbers[row][column]`, with `null` in the free centre.
 *
 * Row-major rather than column-major even though the numbers are drawn per column,
 * because every consumer - line checking, rendering, the accessible label - reads it
 * in rows.
 */
export type BingoCard = ReadonlyArray<ReadonlyArray<number | null>>;

export interface BingoResult {
  /** The ball number, 1-based, at which this card completed a line. */
  ball: number | null;
  /** The winning line's cells, for highlighting. Empty if it never completed. */
  line: ReadonlyArray<readonly [number, number]>;
  multiplier: number;
}

// --------------------------------------------------------------------- geometry --

const isFree = (row: number, column: number): boolean =>
  row === FREE_CELL[0] && column === FREE_CELL[1];

/**
 * The number in one square, or `null` where there is nothing to cover.
 *
 * A square off the edge of the card reads as `null` too. That is unreachable - every
 * caller walks `LINES`, which is generated from `CARD_SIZE` - and it is the accessor
 * rather than each of a dozen call sites that carries the cast, which is the point: the
 * alternative under `noUncheckedIndexedAccess` is `number | null | undefined` spreading
 * through every line check that ever looks at a card.
 */
export const cellAt = (card: BingoCard, row: number, column: number): number | null =>
  (card[row] as ReadonlyArray<number | null> | undefined)?.[column] ?? null;

/** Every line on a 5x5 card: five rows, five columns, two diagonals. */
export const LINES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = (() => {
  const lines: Array<Array<readonly [number, number]>> = [];
  for (let r = 0; r < CARD_SIZE; r += 1) {
    lines.push(Array.from({ length: CARD_SIZE }, (_, c) => [r, c] as const));
  }
  for (let c = 0; c < CARD_SIZE; c += 1) {
    lines.push(Array.from({ length: CARD_SIZE }, (_, r) => [r, c] as const));
  }
  lines.push(Array.from({ length: CARD_SIZE }, (_, i) => [i, i] as const));
  lines.push(Array.from({ length: CARD_SIZE }, (_, i) => [i, CARD_SIZE - 1 - i] as const));
  return lines;
})();

// ------------------------------------------------------------------- the paytable --

export interface Tier {
  /** Highest ball number in this band. */
  upTo: number;
  multiplier: number;
}

/**
 * What a line is worth, by the ball it completed on.
 *
 * Derived rather than invented: the exact probability of each band comes from
 * `exactOdds`, and the multipliers were searched over a ladder of numbers a paytable
 * plausibly prints until the whole table returned 99%. It returns 99.0014%, which
 * `returnToPlayer` recomputes and a test pins.
 */
export const TIERS: readonly Tier[] = [
  { upTo: 20, multiplier: 10 },
  { upTo: 27, multiplier: 2.5 },
  { upTo: 33, multiplier: 1.25 },
  { upTo: 39, multiplier: 1 },
  { upTo: 45, multiplier: 0.75 },
  { upTo: BALLS_DRAWN, multiplier: 0.4 },
];

/** What a card completing on `ball` pays. A card that never completed pays nothing. */
export function multiplierForBall(ball: number | null): number {
  if (ball === null) return 0;
  for (const tier of TIERS) if (ball <= tier.upTo) return tier.multiplier;
  return 0;
}

// ------------------------------------------------------------------------ odds --

/**
 * `C(n, k)` as exact integers, for n up to 75.
 *
 * BigInt, and deliberately. `C(75, 37)` is past 2^53, and the sum below is an
 * *alternating* one over 4,095 terms - the worst case for floating point, because the
 * terms are far larger than the answer and cancel almost entirely. Computing it in
 * doubles was the first attempt: it gave the right figures to eleven decimal places and
 * then reported a probability of 1.000000000005 at ball 74, above the 1.0 it reaches at
 * ball 75. Harmless in itself - it is fifty balls that pay - but a distribution that is
 * not monotonic is a distribution that could have a negative entry in it, and this table
 * is computed once for the life of the process, so there is nothing to be bought by
 * approximating it.
 *
 * The plan's "no BigInt" rule is about the fairness stream, which does this per draw.
 */
const CHOOSE: bigint[][] = (() => {
  const rows: bigint[][] = [];
  for (let n = 0; n <= POOL; n += 1) {
    const row: bigint[] = [1n];
    for (let k = 1; k <= n; k += 1) {
      row.push(((rows[n - 1] as bigint[])[k - 1] as bigint) + ((rows[n - 1] as bigint[])[k] ?? 0n));
    }
    rows.push(row);
  }
  return rows;
})();

const choose = (n: number, k: number): bigint =>
  k < 0 || k > n ? 0n : ((CHOOSE[n] as bigint[])[k] as bigint);

/**
 * An exact fraction as the nearest double.
 *
 * Scaling by 2^60 before dividing keeps about eighteen significant digits, which is more
 * than a double holds, so the result is the correctly rounded value of the exact ratio.
 * That is what makes the distribution monotonic: rounding is order-preserving, so an
 * exactly increasing sequence cannot come out of here decreasing.
 */
const SCALE = 60n;

const ratio = (numerator: bigint, denominator: bigint): number =>
  denominator === 0n ? 0 : Number((numerator << SCALE) / denominator) / 2 ** Number(SCALE);

/**
 * Inclusion-exclusion weights: how many subsets of the twelve lines cover exactly `n`
 * squares, signed by parity.
 *
 * Computed once. It depends only on the card's *geometry* - which squares each line
 * covers - and not at all on which numbers are printed on it, which is why one odds
 * table serves every card.
 */
const INCLUSION_WEIGHTS: ReadonlyMap<number, number> = (() => {
  const cellId = (row: number, column: number): number => row * CARD_SIZE + column;
  const sets = LINES.map(
    (cells) => new Set(cells.filter(([r, c]) => !isFree(r, c)).map(([r, c]) => cellId(r, c))),
  );

  const weights = new Map<number, number>();
  for (let mask = 1; mask < 1 << sets.length; mask += 1) {
    const union = new Set<number>();
    let chosen = 0;
    for (let i = 0; i < sets.length; i += 1) {
      if (!(mask & (1 << i))) continue;
      chosen += 1;
      for (const cell of sets[i] as Set<number>) union.add(cell);
    }
    const sign = chosen % 2 === 1 ? 1 : -1;
    weights.set(union.size, (weights.get(union.size) ?? 0) + sign);
  }
  return weights;
})();

/**
 * Chance a card has completed at least one line by ball `balls`.
 *
 * `P(a given s numbers are all among the first k balls) = C(75-s, k-s) / C(75, k)`, and
 * every term shares that denominator - so the whole inclusion-exclusion is one exact
 * integer over one exact integer, rounded once at the end.
 */
export function chanceCompleteBy(balls: number): number {
  let numerator = 0n;
  for (const [size, weight] of INCLUSION_WEIGHTS) {
    if (balls < size) continue;
    numerator += BigInt(weight) * choose(POOL - size, balls - size);
  }
  return ratio(numerator, choose(POOL, balls));
}

export interface BingoOdds {
  /** Chance of completing exactly on each ball, indexed by ball number. */
  byBall: readonly number[];
  /** Chance of landing in each tier, in the same order as `TIERS`. */
  byTier: readonly number[];
  /** Chance the card never completes inside the round. */
  missChance: number;
  rtp: number;
  /** Expected balls until a line, over the whole 75 - useful for the blurb. */
  meanBalls: number;
}

let cachedOdds: BingoOdds | null = null;

/** The whole distribution, exactly. Cached: it is a constant of the geometry. */
export function exactOdds(): BingoOdds {
  if (cachedOdds) return cachedOdds;

  const byBall: number[] = Array.from({ length: POOL + 1 }, () => 0);
  let previous = 0;
  let meanBalls = 0;
  for (let ball = 1; ball <= POOL; ball += 1) {
    const cumulative = chanceCompleteBy(ball);
    byBall[ball] = cumulative - previous;
    meanBalls += ball * (byBall[ball] as number);
    previous = cumulative;
  }

  const byTier = TIERS.map((tier, index) => {
    const from = index === 0 ? 1 : (TIERS[index - 1] as Tier).upTo + 1;
    let sum = 0;
    for (let ball = from; ball <= tier.upTo; ball += 1) sum += byBall[ball] as number;
    return sum;
  });

  const rtp = byTier.reduce((sum, p, i) => sum + p * (TIERS[i] as Tier).multiplier, 0);
  cachedOdds = {
    byBall,
    byTier,
    missChance: 1 - chanceCompleteBy(BALLS_DRAWN),
    rtp,
    meanBalls,
  };
  return cachedOdds;
}

export const returnToPlayer = (): number => exactOdds().rtp;

// ----------------------------------------------------------------------- play --

/**
 * Deal one card.
 *
 * Five numbers per column, taken from that column's own fifteen, which is what makes a
 * bingo card a bingo card rather than twenty-five numbers from a hat.
 */
export function makeCard(draw: FairSource): BingoCard {
  const columns: number[][] = [];
  for (let column = 0; column < CARD_SIZE; column += 1) {
    const low = column * COLUMN_RANGE + 1;
    const range = Array.from({ length: COLUMN_RANGE }, (_, i) => low + i);
    columns.push(draw.sample(range, CARD_SIZE));
  }

  return Array.from({ length: CARD_SIZE }, (_, row) =>
    Array.from({ length: CARD_SIZE }, (_, column) =>
      isFree(row, column) ? null : ((columns[column] as number[])[row] as number),
    ),
  );
}

/** Call the balls for a round: the whole pool shuffled, of which the first fifty play. */
export function drawBalls(draw: FairSource): number[] {
  return draw.shuffle(Array.from({ length: POOL }, (_, i) => i + 1)).slice(0, BALLS_DRAWN);
}

/**
 * Settle one card against a ball sequence.
 *
 * Returns the *earliest* ball at which any line completed. Ties between lines do not
 * matter - the ball is what pays, not which line got there - but the line is reported so
 * the card can show why it won.
 */
export function settleCard(card: BingoCard, balls: readonly number[]): BingoResult {
  const seen = new Map<number, number>();
  for (let i = 0; i < balls.length; i += 1) {
    const ball = balls[i] as number;
    if (!seen.has(ball)) seen.set(ball, i + 1);
  }

  /** The ball at which a whole line is covered, or null. */
  const lineCompletesAt = (
    line: ReadonlyArray<readonly [number, number]>,
  ): number | null => {
    let latest = 0;
    for (const [row, column] of line) {
      const value = cellAt(card, row, column);
      if (value === null) continue; // the free square is covered from the off
      const at = seen.get(value);
      if (at === undefined) return null;
      latest = Math.max(latest, at);
    }
    return latest;
  };

  let best: { ball: number; line: ReadonlyArray<readonly [number, number]> } | null = null;
  for (const line of LINES) {
    const at = lineCompletesAt(line);
    if (at === null) continue;
    if (best === null || at < best.ball) best = { ball: at, line };
  }

  return best === null
    ? { ball: null, line: [], multiplier: 0 }
    : { ball: best.ball, line: best.line, multiplier: multiplierForBall(best.ball) };
}

/** What a settled card pays on a given stake. */
export function payoutForCard(stake: number, result: BingoResult): number {
  if (!Number.isInteger(stake) || stake <= 0) throw new BingoError('stake must be positive');
  return result.multiplier > 0 ? payoutFor(stake, result.multiplier) : 0;
}

export const houseEdge = (): number => 1 - returnToPlayer();
export { HOUSE_EDGE };
