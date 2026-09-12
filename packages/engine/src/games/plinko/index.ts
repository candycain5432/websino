/**
 * Plinko: drop a ball through a triangle of pegs and see which bucket it lands in.
 *
 * Fairness draw order: exactly one `nextFloat()` per row, in order, top to bottom. Each
 * is a left/right bounce, so a `rows`-row board consumes exactly `rows` floats and the
 * path replays from the seed exactly.
 *
 * The bucket is the number of rights, so bucket `k` has probability `C(rows, k) / 2^rows`
 * - a binomial. The middle is overwhelmingly likely and the edges are rare, which is why
 * the multipliers have to be shaped the way they are.
 *
 * **The multipliers are derived, not typed in.** Every other plinko implementation ships
 * hand-tuned tables per (rows, risk), which is a lot of magic numbers whose return to
 * player nobody can check and which drift the moment anyone "just tweaks one". Here a
 * risk level is a single number - how fast the payout grows as you move away from the
 * centre - and the table is that shape normalised so the expected return is the house
 * edge by construction:
 *
 *     shape(k)      = base ^ |k - centre|
 *     multiplier(k) = (1 - edge) * shape(k) / E[shape]
 *
 * Which makes the return to player exactly `1 - edge` before rounding, for every board
 * size and every risk, with no table to get wrong. The three bases were then chosen by
 * searching for the value that gives each risk level a headline multiplier worth playing
 * for while keeping every board's *rounded* return within a tenth of a point of 99%.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';
import { comb } from '../../util/combinatorics.js';

/** Board sizes offered. Each is a row count, and buckets are always `rows + 1`. */
export const ROW_CHOICES = [8, 12, 16] as const;
export type Rows = (typeof ROW_CHOICES)[number];

export type Risk = 'low' | 'medium' | 'high';

/**
 * How steeply the payout climbs per step away from the centre.
 *
 * This is the whole of a risk level. Low barely rewards the edges and rarely takes the
 * whole stake; high turns the board into a lottery with a centre that loses most of it.
 */
export const RISK_BASE: Record<Risk, number> = {
  low: 1.42,
  medium: 1.89,
  high: 2.73,
};

export interface PlinkoConfig {
  rows: Rows;
  risk: Risk;
}

export interface PlinkoDetail {
  /** Each bounce, top to bottom. `true` is a bounce to the right. */
  path: boolean[];
  /** Which bucket the ball landed in, 0..rows. */
  bucket: number;
  rows: Rows;
  risk: Risk;
  /** Every bucket's multiplier, so the client renders the board the server used. */
  multipliers: number[];
}

/** `C(rows, k) / 2^rows` - the chance of landing in bucket `k`. */
export function bucketChance(rows: number, k: number): number {
  return comb(rows, k) / 2 ** rows;
}

/** The unnormalised payout shape: how much bucket `k` is "worth" before scaling. */
function shapeOf(rows: number, risk: Risk, k: number): number {
  const centre = rows / 2;
  return (RISK_BASE[risk] as number) ** Math.abs(k - centre);
}

/**
 * The multiplier table for a board.
 *
 * Rounded to two decimals because the number on the bucket is the number that pays - a
 * player should never be quoted 4.37 and paid 4.3712. Rounding perturbs the return to
 * player very slightly off `1 - edge`, so `returnToPlayer` below reports the real figure
 * and a test pins it rather than trusting the construction.
 */
export function multipliersFor(config: PlinkoConfig): number[] {
  const { rows, risk } = config;
  const buckets = rows + 1;

  let expected = 0;
  for (let k = 0; k < buckets; k += 1) expected += bucketChance(rows, k) * shapeOf(rows, risk, k);

  const scale = (1 - HOUSE_EDGE) / expected;
  return Array.from({ length: buckets }, (_, k) =>
    Math.round(shapeOf(rows, risk, k) * scale * 100) / 100,
  );
}

/** The exact return to player for a board, as the rounded table actually pays it. */
export function returnToPlayer(config: PlinkoConfig): number {
  const multipliers = multipliersFor(config);
  let rtp = 0;
  for (let k = 0; k < multipliers.length; k += 1) {
    rtp += bucketChance(config.rows, k) * (multipliers[k] as number);
  }
  return rtp;
}

export const plinko: RoundGame<PlinkoConfig, PlinkoDetail> = {
  id: 'plinko',
  name: 'Plinko',
  houseEdge: HOUSE_EDGE,
  defaultConfig: { rows: 16, risk: 'medium' },

  validateConfig(config) {
    if (!ROW_CHOICES.includes(config.rows)) {
      throw new Error(`rows must be one of ${ROW_CHOICES.join(', ')}`);
    }
    if (!(config.risk in RISK_BASE)) throw new Error('risk must be low, medium or high');
  },

  play(config, bet, draw: FairSource): RoundOutcome<PlinkoDetail> {
    this.validateConfig(config);

    // One float per row, top to bottom. The path is the outcome; the bucket is just
    // where it ends up, so a replay from the seed reproduces the animation too.
    const path: boolean[] = [];
    for (let row = 0; row < config.rows; row += 1) path.push(draw.nextFloat() < 0.5);

    const bucket = path.filter(Boolean).length;
    const multipliers = multipliersFor(config);
    const multiplier = multipliers[bucket] as number;

    return {
      payout: payoutFor(bet, multiplier),
      multiplier,
      detail: { path, bucket, rows: config.rows, risk: config.risk, multipliers },
    };
  },
};
