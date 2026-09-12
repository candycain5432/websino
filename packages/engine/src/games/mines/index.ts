/**
 * Mines: uncover gems on a 5x5 grid, cash out before you hit a bomb.
 *
 * The multiplier after `k` safe picks is the inverse of the probability of getting that
 * far, scaled by the house edge:
 *
 *     multiplier(k) = (1 - edge) / P(k consecutive safe picks)
 *
 * which makes **every cash-out point carry exactly the same expected return**. Playing it
 * safe and going for the whole board are worth the same; only the variance changes. The
 * tests assert that identity exactly rather than by simulation.
 *
 * **Fairness draw order.** One `shuffle()` of the 25 tile indices at `start`, whose first
 * `mines` entries are the mine positions. Shuffling rather than sampling is deliberate:
 * it consumes a fixed number of draws regardless of the mine count, so the stream position
 * after a round does not depend on how the player configured it.
 *
 * The board is laid at `start` and never revealed until the round ends - `reveal` answers
 * one tile at a time, which is the only shape that keeps the server honest without
 * handing the client the map.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import { chooseRatio } from '../../util/combinatorics.js';

export const GRID_SIZE = 5;
export const TILE_COUNT = GRID_SIZE * GRID_SIZE;
export const MIN_MINES = 1;
export const MAX_MINES = 24;

export type MinesState = 'playing' | 'busted' | 'cashed';

export class MinesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MinesError';
  }
}

export interface MinesRound {
  bet: number;
  mines: number;
  /** Secret until the round ends. */
  minePositions: number[];
  revealed: number[];
  hitPosition: number | null;
  state: MinesState;
}

/** Probability of making `picks` safe picks in a row. */
export function safeProbability(mines: number, picks: number): number {
  const safe = TILE_COUNT - mines;
  if (picks > safe) return 0;
  // C(safe, picks) / C(25, picks), computed as a ratio so nothing overflows.
  return chooseRatio(safe, TILE_COUNT, picks);
}

/** Payout multiplier after `picks` successful reveals. */
export function multiplierFor(mines: number, picks: number, edge = HOUSE_EDGE): number {
  if (picks <= 0) return 1;
  const probability = safeProbability(mines, picks);
  if (probability <= 0) throw new MinesError('more picks than there are safe tiles');
  return (1 - edge) / probability;
}

/** Every multiplier from one pick up to clearing the board. */
export function multiplierTable(mines: number, edge = HOUSE_EDGE): number[] {
  const safe = TILE_COUNT - mines;
  return Array.from({ length: safe }, (_, i) => multiplierFor(mines, i + 1, edge));
}

export const safeTiles = (mines: number): number => TILE_COUNT - mines;

export const isCleared = (round: MinesRound): boolean =>
  round.revealed.length >= safeTiles(round.mines);

export function currentMultiplier(round: MinesRound): number {
  return round.revealed.length > 0 ? multiplierFor(round.mines, round.revealed.length) : 1;
}

/** What cashing out right now would return, stake included. */
export function currentPayout(round: MinesRound): number {
  if (round.state === 'busted') return 0;
  if (round.revealed.length === 0) return round.bet;
  return payoutFor(round.bet, currentMultiplier(round));
}

export function nextMultiplier(round: MinesRound): number | null {
  if (round.revealed.length >= safeTiles(round.mines)) return null;
  return multiplierFor(round.mines, round.revealed.length + 1);
}

export function startMines(bet: number, mines: number, draw: FairSource): MinesRound {
  if (!Number.isInteger(bet) || bet <= 0) throw new MinesError('bet must be positive');
  if (!Number.isInteger(mines) || mines < MIN_MINES || mines > MAX_MINES) {
    throw new MinesError(`mines must be between ${MIN_MINES} and ${MAX_MINES}`);
  }
  const order = draw.shuffle(Array.from({ length: TILE_COUNT }, (_, i) => i));
  return {
    bet,
    mines,
    minePositions: order.slice(0, mines),
    revealed: [],
    hitPosition: null,
    state: 'playing',
  };
}

/** Uncover a tile. A bomb ends the round; clearing the board cashes out at the top. */
export function reveal(round: MinesRound, position: number): MinesRound {
  if (round.state !== 'playing') throw new MinesError('no board in play');
  if (!Number.isInteger(position) || position < 0 || position >= TILE_COUNT) {
    throw new MinesError('position off the board');
  }
  if (round.revealed.includes(position)) throw new MinesError('tile already revealed');

  if (round.minePositions.includes(position)) {
    return { ...round, hitPosition: position, state: 'busted' };
  }

  const revealed = [...round.revealed, position];
  const next: MinesRound = { ...round, revealed };
  // Clearing the board is an automatic cash-out at the maximum multiplier.
  return isCleared(next) ? { ...next, state: 'cashed' } : next;
}

export function cashOut(round: MinesRound): MinesRound {
  if (round.state === 'cashed') return round;
  if (round.state !== 'playing') throw new MinesError('nothing to cash out');
  if (round.revealed.length === 0) {
    throw new MinesError('reveal at least one tile before cashing out');
  }
  return { ...round, state: 'cashed' };
}
