/**
 * Dice: roll 0.00-99.99, bet on whether the roll lands over or under a target.
 *
 * Fairness draw order: exactly one `nextFloat()`, converted to a roll in hundredths.
 * The multiplier is derived from the win chance, so every target has identical expected
 * value - picking a 2% shot instead of a 90% one changes variance, not edge.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';

/** Rolls are integers 0..9999, displayed as 0.00..99.99. */
export const ROLL_RANGE = 10_000;

/** Keeping win chance inside these bounds stops degenerate 0% / 100% bets. */
export const MIN_WIN_CHANCE = 0.01;
export const MAX_WIN_CHANCE = 0.95;

export type DiceDirection = 'over' | 'under';

export interface DiceConfig {
  /** Target in hundredths, 0..9999 - so 4550 means 45.50. */
  target: number;
  direction: DiceDirection;
}

export interface DiceDetail {
  roll: number;
  target: number;
  direction: DiceDirection;
  won: boolean;
  winChance: number;
}

/** How many of the 10,000 outcomes win, for a given target and direction. */
export function winningOutcomes(config: DiceConfig): number {
  return config.direction === 'over' ? ROLL_RANGE - 1 - config.target : config.target;
}

export const winChanceOf = (config: DiceConfig): number =>
  winningOutcomes(config) / ROLL_RANGE;

/** Payout multiplier. Always (1 - edge) / winChance, so EV is flat across targets. */
export function multiplierFor(config: DiceConfig): number {
  const chance = winChanceOf(config);
  if (chance <= 0) return 0;
  return (1 - HOUSE_EDGE) / chance;
}

export const dice: RoundGame<DiceConfig, DiceDetail> = {
  id: 'dice',
  name: 'Dice',
  houseEdge: HOUSE_EDGE,
  defaultConfig: { target: 5000, direction: 'over' },

  validateConfig(config) {
    if (!Number.isInteger(config.target)) throw new Error('target must be an integer');
    if (config.target < 0 || config.target > ROLL_RANGE - 1) {
      throw new Error(`target must be 0..${ROLL_RANGE - 1}`);
    }
    if (config.direction !== 'over' && config.direction !== 'under') {
      throw new Error('direction must be "over" or "under"');
    }
    const chance = winChanceOf(config);
    if (chance < MIN_WIN_CHANCE || chance > MAX_WIN_CHANCE) {
      throw new Error(
        `win chance ${(chance * 100).toFixed(2)}% is outside the permitted ` +
          `${MIN_WIN_CHANCE * 100}%-${MAX_WIN_CHANCE * 100}% range`,
      );
    }
  },

  play(config, bet, draw: FairSource): RoundOutcome<DiceDetail> {
    this.validateConfig(config);
    const roll = Math.floor(draw.nextFloat() * ROLL_RANGE);
    const won = config.direction === 'over' ? roll > config.target : roll < config.target;
    const multiplier = multiplierFor(config);
    return {
      payout: won ? payoutFor(bet, multiplier) : 0,
      multiplier: won ? multiplier : 0,
      detail: { roll, target: config.target, direction: config.direction, won, winChance: winChanceOf(config) },
    };
  },
};
