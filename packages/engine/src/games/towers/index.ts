/**
 * Towers: climb a tower one row at a time, picking a safe tile on each.
 *
 * Mines with a ladder instead of a grid, and the same identity holds: the multiplier
 * after `k` rows is the inverse of the chance of getting that far, scaled by the edge,
 *
 *     multiplier(k) = (1 - edge) / p^k,   p = safe tiles per row / tiles per row
 *
 * so **every cash-out height carries exactly the same expected return**. Stopping at row
 * two and going for the top are worth the same; only the variance differs. The tests
 * assert that exactly rather than by simulation.
 *
 * **Fairness draw order.** One `shuffle()` of each row's tile indices at `start`, bottom
 * row first, whose leading entries are that row's traps. Every row is shuffled up front
 * even though the player may never reach it, so the number of draws a round consumes
 * depends only on the difficulty chosen and never on how far the player got - a round
 * that ends on row one leaves the stream exactly where a round that cleared the tower
 * would.
 *
 * The tower is laid at `start` and never revealed until the round ends. `climb` answers
 * one row at a time, which is the only shape that keeps the server honest without
 * handing the client the map.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';

export const ROWS = 8;

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert' | 'master';
export type TowersState = 'playing' | 'busted' | 'cashed';

/** Tiles per row and how many of them are traps. */
export const DIFFICULTIES: Record<Difficulty, { tiles: number; traps: number }> = {
  easy: { tiles: 4, traps: 1 },
  medium: { tiles: 3, traps: 1 },
  hard: { tiles: 2, traps: 1 },
  expert: { tiles: 3, traps: 2 },
  master: { tiles: 4, traps: 3 },
};

export class TowersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowersError';
  }
}

export interface TowersRound {
  bet: number;
  difficulty: Difficulty;
  /** Trap positions per row, bottom first. Secret until the round ends. */
  traps: number[][];
  /** The tile picked on each cleared row, bottom first. */
  picks: number[];
  /** Where the round ended, if it ended badly. */
  hit: { row: number; tile: number } | null;
  state: TowersState;
}

export const tilesPerRow = (difficulty: Difficulty): number =>
  (DIFFICULTIES[difficulty] as { tiles: number }).tiles;

export const trapsPerRow = (difficulty: Difficulty): number =>
  (DIFFICULTIES[difficulty] as { traps: number }).traps;

/** The chance one row is survived. */
export function rowChance(difficulty: Difficulty): number {
  const { tiles, traps } = DIFFICULTIES[difficulty];
  return (tiles - traps) / tiles;
}

/** Payout multiplier after clearing `rows` rows. */
export function multiplierFor(difficulty: Difficulty, rows: number, edge = HOUSE_EDGE): number {
  if (rows <= 0) return 1;
  if (rows > ROWS) throw new TowersError('the tower is not that tall');
  return (1 - edge) / rowChance(difficulty) ** rows;
}

/** Every multiplier from the first row to the top. */
export const multiplierTable = (difficulty: Difficulty, edge = HOUSE_EDGE): number[] =>
  Array.from({ length: ROWS }, (_, i) => multiplierFor(difficulty, i + 1, edge));

export const isCleared = (round: TowersRound): boolean => round.picks.length >= ROWS;

export const currentMultiplier = (round: TowersRound): number =>
  multiplierFor(round.difficulty, round.picks.length);

/** What cashing out right now would return, stake included. */
export function currentPayout(round: TowersRound): number {
  if (round.state === 'busted') return 0;
  if (round.picks.length === 0) return round.bet;
  return payoutFor(round.bet, currentMultiplier(round));
}

export function nextMultiplier(round: TowersRound): number | null {
  return isCleared(round) ? null : multiplierFor(round.difficulty, round.picks.length + 1);
}

export function startTowers(bet: number, difficulty: Difficulty, draw: FairSource): TowersRound {
  if (!Number.isInteger(bet) || bet <= 0) throw new TowersError('bet must be positive');
  if (!(difficulty in DIFFICULTIES)) throw new TowersError(`unknown difficulty: ${difficulty}`);

  const { tiles, traps } = DIFFICULTIES[difficulty];
  const rows = Array.from({ length: ROWS }, () =>
    draw.shuffle(Array.from({ length: tiles }, (_, i) => i)).slice(0, traps).sort((a, b) => a - b),
  );

  return { bet, difficulty, traps: rows, picks: [], hit: null, state: 'playing' };
}

/** Step onto a tile in the next row. A trap ends the round; the top cashes out. */
export function climb(round: TowersRound, tile: number): TowersRound {
  if (round.state !== 'playing') throw new TowersError('no tower in play');
  const tiles = tilesPerRow(round.difficulty);
  if (!Number.isInteger(tile) || tile < 0 || tile >= tiles) {
    throw new TowersError('no such tile in this row');
  }

  const row = round.picks.length;
  if ((round.traps[row] as number[]).includes(tile)) {
    return { ...round, hit: { row, tile }, state: 'busted' };
  }

  const next: TowersRound = { ...round, picks: [...round.picks, tile] };
  // Reaching the top is an automatic cash-out at the maximum multiplier.
  return isCleared(next) ? { ...next, state: 'cashed' } : next;
}

export function cashOut(round: TowersRound): TowersRound {
  if (round.state === 'cashed') return round;
  if (round.state !== 'playing') throw new TowersError('nothing to cash out');
  if (round.picks.length === 0) throw new TowersError('clear a row before cashing out');
  return { ...round, state: 'cashed' };
}
