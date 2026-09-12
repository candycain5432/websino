/**
 * Scoring a screen, for any cabinet.
 *
 * Separate from `index.ts` so the exact-return calculator can use it without importing
 * the round machinery, and so the rules that decide what a line is worth sit in one
 * place rather than being duplicated between the engine and the maths that checks it.
 * A payout rule and its RTP proof disagreeing is the failure mode worth designing out.
 */

import { lineCountOf, REELS, ROWS, SCATTER, WILD, type SlotMachine } from './machines.js';

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

/**
 * Score one payline, in line-bet units. Returns `null` for no win.
 *
 * A run must start on reel one. Wilds stand in for any paying symbol, and a leading
 * run of pure wilds is paid at whichever of the two readings is worth more - five wilds
 * pay as five wilds, but three wilds followed by two sevens pay as five sevens if that
 * is the better line.
 */
export function evaluateLine(
  machine: SlotMachine,
  symbols: readonly string[],
): { symbol: string; count: number; units: number } | null {
  let best: { symbol: string; count: number; units: number } | null = null;

  let leadingWilds = 0;
  for (const symbol of symbols) {
    if (symbol !== WILD) break;
    leadingWilds += 1;
  }
  if (leadingWilds >= 3) {
    const units = (machine.paytable[WILD] as readonly number[])[leadingWilds - 3] as number;
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
      const units = (machine.paytable[base] as readonly number[])[run - 3] as number;
      if (best === null || units > best.units) best = { symbol: base, count: run, units };
    }
  }
  return best;
}

/** Score a whole screen: every payline plus scatters. */
export function evaluateGrid(
  machine: SlotMachine,
  grid: ReadonlyArray<readonly string[]>,
  multiplier: number,
  isFreeSpin: boolean,
): Spin {
  const lineWins: LineWin[] = [];

  for (let index = 0; index < machine.paylines.length; index += 1) {
    const pattern = machine.paylines[index] as readonly number[];
    const symbols: string[] = [];
    for (let column = 0; column < REELS; column += 1) {
      symbols.push((grid[pattern[column] as number] as readonly string[])[column] as string);
    }
    const scored = evaluateLine(machine, symbols);
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
    // Scatters pay a multiple of the total bet, which is `lineCount` line-bet units.
    scatterUnits = (machine.scatterPays[capped] ?? 0) * lineCountOf(machine);
    freeSpinsAwarded = machine.freeSpinAward[capped] ?? 0;
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

export { ROWS, REELS };
