/**
 * Golden Reels: five reels, three rows, twenty paylines.
 *
 * Lines pay left to right starting on reel one, wilds substitute for everything except
 * scatters, and three or more scatters anywhere buy free spins that pay double.
 *
 * **Fairness draw order.** One `randBelow(stripLength)` per reel, reels left to right,
 * for each spin. A bonus continues drawing from the same stream, so a round that wins
 * 10 free spins consumes 5 + 10x5 draws in total.
 *
 * **One deliberate difference from pysino**: free spins resolve *inside the round* that
 * triggered them rather than being held as state between requests. pysino's `SlotMachine`
 * carried a `free_spins` counter across calls, which here would mean a stateful session,
 * a persisted counter, and a way for a disconnect to strand a bonus the player had already
 * paid for. Resolving the whole bonus atomically makes slots a true one-shot game - it
 * settles in a single ledger transaction, travels over plain HTTP, and its RTP can be
 * asserted per round rather than per session.
 */

import type { FairSource } from '@websino/fair';

import { payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';
import {
  FREE_SPIN_AWARD, FREE_SPIN_MULTIPLIER, LINE_COUNT, PAYLINES, PAYTABLE, REEL_STRIPS,
  REELS, ROWS, SCATTER, SCATTER_PAYS, WILD,
} from './reels.js';

export * from './reels.js';

/**
 * A bonus can retrigger itself, so the loop needs a ceiling. 500 free spins is far
 * beyond anything reachable in practice (it needs ~50 consecutive retriggers) but it
 * guarantees a round terminates even if the weights are ever changed carelessly.
 */
export const MAX_FREE_SPINS = 500;

export interface LineWin {
  lineIndex: number;
  symbol: string;
  count: number;
  /** Pay in line-bet units. */
  units: number;
  /** `[column, row]` cells that made the win, for highlighting. */
  positions: Array<[number, number]>;
}

export interface Spin {
  /** `grid[row][column]`. */
  grid: string[][];
  lineWins: LineWin[];
  scatterCount: number;
  /** Scatter pay in line-bet units. */
  scatterUnits: number;
  freeSpinsAwarded: number;
  multiplier: number;
  isFreeSpin: boolean;
  /** Total pay for this spin in line-bet units, multiplier already applied. */
  units: number;
}

export interface SlotsDetail {
  spins: Spin[];
  /** Total pay across every spin, in line-bet units. */
  totalUnits: number;
  freeSpinsPlayed: number;
}

/** Stop each reel independently. Returns `grid[row][column]`. */
export function spinGrid(draw: FairSource): string[][] {
  const columns: string[][] = REEL_STRIPS.map((strip) => {
    const stop = draw.randBelow(strip.length);
    const cells: string[] = [];
    for (let offset = 0; offset < ROWS; offset += 1) {
      cells.push(strip[(stop + offset) % strip.length] as string);
    }
    return cells;
  });

  const grid: string[][] = [];
  for (let row = 0; row < ROWS; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < REELS; column += 1) {
      cells.push((columns[column] as string[])[row] as string);
    }
    grid.push(cells);
  }
  return grid;
}

/**
 * Score one payline, in line-bet units. Returns `null` for no win.
 *
 * A run must start on reel one. Wilds stand in for any paying symbol, and a leading
 * run of pure wilds is paid at whichever of the two readings is worth more - five wilds
 * pay as five wilds, but three wilds followed by two sevens pay as five sevens if that
 * is the better line.
 */
export function evaluateLine(
  symbols: readonly string[],
): { symbol: string; count: number; units: number } | null {
  let best: { symbol: string; count: number; units: number } | null = null;

  let leadingWilds = 0;
  for (const symbol of symbols) {
    if (symbol !== WILD) break;
    leadingWilds += 1;
  }
  if (leadingWilds >= 3) {
    const units = (PAYTABLE[WILD] as readonly number[])[leadingWilds - 3] as number;
    best = { symbol: WILD, count: leadingWilds, units };
  }

  const base = symbols.find((s) => s !== WILD && s !== SCATTER);
  if (base !== undefined) {
    let run = 0;
    for (const symbol of symbols) {
      if (symbol === base || symbol === WILD) run += 1;
      else break;
    }
    if (run >= 3) {
      const units = (PAYTABLE[base] as readonly number[])[run - 3] as number;
      if (best === null || units > best.units) best = { symbol: base, count: run, units };
    }
  }
  return best;
}

/** Score a whole screen: every payline plus scatters. */
export function evaluateGrid(
  grid: ReadonlyArray<readonly string[]>,
  multiplier: number,
  isFreeSpin: boolean,
): Spin {
  const lineWins: LineWin[] = [];

  for (let index = 0; index < PAYLINES.length; index += 1) {
    const pattern = PAYLINES[index] as readonly number[];
    const symbols: string[] = [];
    for (let column = 0; column < REELS; column += 1) {
      symbols.push((grid[pattern[column] as number] as readonly string[])[column] as string);
    }
    const scored = evaluateLine(symbols);
    if (scored) {
      const positions: Array<[number, number]> = [];
      for (let column = 0; column < scored.count; column += 1) {
        positions.push([column, pattern[column] as number]);
      }
      lineWins.push({ lineIndex: index, ...scored, positions });
    }
  }

  let scatterCount = 0;
  for (const row of grid) for (const cell of row) if (cell === SCATTER) scatterCount += 1;

  let scatterUnits = 0;
  let freeSpinsAwarded = 0;
  if (scatterCount >= 3) {
    const capped = Math.min(scatterCount, 5);
    // Scatters pay a multiple of the total bet, which is LINE_COUNT line-bet units.
    scatterUnits = (SCATTER_PAYS[capped] as number) * LINE_COUNT;
    freeSpinsAwarded = FREE_SPIN_AWARD[capped] as number;
  }

  const base = lineWins.reduce((sum, w) => sum + w.units, 0) + scatterUnits;
  return {
    grid: grid.map((row) => [...row]),
    lineWins,
    scatterCount,
    scatterUnits,
    freeSpinsAwarded,
    multiplier,
    isFreeSpin,
    units: base * multiplier,
  };
}

export const slots: RoundGame<Record<string, never>, SlotsDetail> = {
  id: 'slots',
  name: 'Golden Reels',
  // Not the flat 1% of the maths games: this one's return comes out of the paytable and
  // reel weights, and is pinned by simulation in the tests rather than set by a constant.
  houseEdge: 0.05,
  defaultConfig: {},

  validateConfig() {
    // Nothing to configure - all twenty lines are always in play, which is what makes
    // the stake a single number and the RTP a single number to defend.
  },

  play(_config, bet, draw: FairSource): RoundOutcome<SlotsDetail> {
    const spins: Spin[] = [];

    spins.push(evaluateGrid(spinGrid(draw), 1, false));

    let remaining = spins[0]?.freeSpinsAwarded ?? 0;
    let played = 0;
    while (remaining > 0 && played < MAX_FREE_SPINS) {
      remaining -= 1;
      played += 1;
      const spin = evaluateGrid(spinGrid(draw), FREE_SPIN_MULTIPLIER, true);
      // Scatters landing during a bonus retrigger it.
      remaining += spin.freeSpinsAwarded;
      spins.push(spin);
    }

    const totalUnits = spins.reduce((sum, s) => sum + s.units, 0);
    // One floor for the whole round. A line-bet unit is bet/20, and accumulating in
    // units means a bonus of forty small wins cannot lose a chip per win to rounding.
    const payout = payoutFor(bet, totalUnits / LINE_COUNT);

    return {
      payout,
      multiplier: bet > 0 ? payout / bet : 0,
      detail: { spins, totalUnits, freeSpinsPlayed: played },
    };
  },
};
