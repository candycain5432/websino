/**
 * Slots: five reels, three rows, and a cabinet chosen from the floor.
 *
 * Lines pay left to right starting on reel one, wilds substitute for everything except
 * scatters, and three or more scatters anywhere buy free spins that pay a multiplier.
 * All of that is shared mechanism; what differs between cabinets - symbols, paytable,
 * lines, weights, bonus rules - is data in `machines.ts`.
 *
 * **Fairness draw order.** One `randBelow(stripLength)` per reel, reels left to right,
 * for each spin. A bonus continues drawing from the same stream, so a round that wins
 * 10 free spins consumes 5 + 10x5 draws in total. The strips differ per cabinet, so the
 * machine is part of the round's configuration and is recorded with it.
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
import { evaluateGrid, type Spin } from './evaluate.js';
import {
  GOLDEN_REELS, lineCountOf, machineById, REELS, ROWS, stripsOf, type SlotMachine,
} from './machines.js';
import { exactReturn } from './rtp.js';

export * from './machines.js';
export * from './evaluate.js';
export * from './rtp.js';

/**
 * A bonus can retrigger itself, so the loop needs a ceiling. 500 free spins is far
 * beyond anything reachable in practice (it needs ~50 consecutive retriggers) but it
 * guarantees a round terminates even if the weights are ever changed carelessly.
 */
export const MAX_FREE_SPINS = 500;

export interface SlotsConfig {
  /** Which cabinet. Omitted means the house classic. */
  machine?: string;
}

export interface SlotsDetail {
  machine: string;
  spins: Spin[];
  /** Total pay across every spin, in line-bet units. */
  totalUnits: number;
  freeSpinsPlayed: number;
  /** Lines in play on this cabinet - the divisor for `totalUnits`. */
  lineCount: number;
}

/** Stop each reel independently. Returns `grid[row][column]`. */
export function spinGrid(machine: SlotMachine, draw: FairSource): string[][] {
  const columns: string[][] = stripsOf(machine).map((strip) => {
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

export const slots: RoundGame<SlotsConfig, SlotsDetail> = {
  id: 'slots',
  name: 'Slots',
  /**
   * Not the flat 1% of the maths games, and not one number either - each cabinet's
   * return comes out of its own paytable and weights. This is the classic's figure,
   * quoted exactly rather than rounded, and `exactReturn` gives the rest.
   */
  houseEdge: 1 - exactReturn(GOLDEN_REELS).rtp,
  defaultConfig: {},

  validateConfig(config) {
    // Every line on a cabinet is always in play, which is what makes the stake a single
    // number. The only thing to validate is that the cabinet exists.
    if (config.machine !== undefined) machineById(config.machine);
  },

  play(config, bet, draw: FairSource): RoundOutcome<SlotsDetail> {
    const machine = config.machine === undefined ? GOLDEN_REELS : machineById(config.machine);
    const lines = lineCountOf(machine);
    const spins: Spin[] = [];

    spins.push(evaluateGrid(machine, spinGrid(machine, draw), 1, false));

    let remaining = spins[0]?.freeSpinsAwarded ?? 0;
    let played = 0;
    while (remaining > 0 && played < MAX_FREE_SPINS) {
      remaining -= 1;
      played += 1;
      const spin = evaluateGrid(
        machine, spinGrid(machine, draw), machine.freeSpinMultiplier, true,
      );
      // Scatters landing during a bonus retrigger it.
      remaining += spin.freeSpinsAwarded;
      spins.push(spin);
    }

    const totalUnits = spins.reduce((sum, s) => sum + s.units, 0);
    // One floor for the whole round. A line-bet unit is bet/lines, and accumulating in
    // units means a bonus of forty small wins cannot lose a chip per win to rounding.
    const payout = payoutFor(bet, totalUnits / lines);

    return {
      payout,
      multiplier: bet > 0 ? payout / bet : 0,
      detail: { machine: machine.id, spins, totalUnits, freeSpinsPlayed: played, lineCount: lines },
    };
  },
};
