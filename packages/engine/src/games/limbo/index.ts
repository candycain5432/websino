/**
 * Limbo: a multiplier is drawn; you win if it lands at or above your target.
 *
 * Fairness draw order: exactly one `nextFloat()`.
 *
 * The draw satisfies P(result >= x) = (1 - edge) / x, so cashing at any target is worth
 * the same. This is the same distribution crash uses - limbo is simply crash without
 * the waiting, which makes it the ideal game to prove the pipeline with.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';

/** Multipliers are handled in hundredths to keep every comparison integral. */
export const MULTIPLIER_SCALE = 100;
export const MIN_TARGET = 101; // 1.01x
export const MAX_TARGET = 100_000_00; // 100,000.00x

export interface LimboConfig {
  /** Target multiplier in hundredths - 200 means 2.00x. */
  target: number;
}

export interface LimboDetail {
  /** The drawn multiplier in hundredths. */
  result: number;
  target: number;
  won: boolean;
}

/**
 * Draw a multiplier in hundredths.
 *
 * Values below 1.00x floor to 1.00x, and that happens with probability exactly `edge` -
 * which is where the house edge lives. It must not also be subtracted anywhere else;
 * pysino's crash had precisely that double-subtraction bug and paid 97% instead of 99%.
 */
export function drawMultiplier(draw: FairSource, edge = HOUSE_EDGE): number {
  const f = draw.nextFloat();
  const raw = (1 - edge) / (1 - f);
  return Math.max(MULTIPLIER_SCALE, Math.floor(raw * MULTIPLIER_SCALE));
}

export const limbo: RoundGame<LimboConfig, LimboDetail> = {
  id: 'limbo',
  name: 'Limbo',
  houseEdge: HOUSE_EDGE,
  defaultConfig: { target: 200 },

  validateConfig(config) {
    if (!Number.isInteger(config.target)) throw new Error('target must be an integer');
    if (config.target < MIN_TARGET || config.target > MAX_TARGET) {
      throw new Error(`target must be ${MIN_TARGET}..${MAX_TARGET} hundredths`);
    }
  },

  play(config, bet, draw: FairSource): RoundOutcome<LimboDetail> {
    this.validateConfig(config);
    const result = drawMultiplier(draw);
    const won = result >= config.target;
    const multiplier = config.target / MULTIPLIER_SCALE;
    return {
      payout: won ? payoutFor(bet, multiplier) : 0,
      multiplier: won ? multiplier : 0,
      detail: { result, target: config.target, won },
    };
  },
};
