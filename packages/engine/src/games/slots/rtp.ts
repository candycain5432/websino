/**
 * What a cabinet returns, computed rather than sampled.
 *
 * This used to live inside the slots test, which was fine while there was one machine.
 * With a variety pack it has to be a property of the machine: a new cabinet must not be
 * addable without its economics being knowable, and "run it a few million times and
 * squint" is not knowing. The bonus tail dominates the variance, so even a very long
 * simulation says little - the exact figure is both cheaper and better.
 *
 * The whole thing is three pieces:
 *
 *   lineEV      enumerate every 5-symbol combination a payline can show, weighted by
 *               each reel's own symbol distribution
 *   scatterEV   the exact distribution of scatters on screen, convolved reel by reel
 *   bonus       free spins retrigger, so the expected count per round is a geometric
 *               series in the per-spin award rate
 *
 * `lineEV` walks `symbols^5` combinations - a few thousand per machine, since a reel
 * has under ten distinct symbols. That is instant and does not need caching, but it is
 * cached anyway because the UI quotes these figures on every render.
 */

import { evaluateLine } from './evaluate.js';
import { lineCountOf, ROWS, SCATTER, stripsOf, type SlotMachine } from './machines.js';

export interface MachineReturn {
  /** Return to player, as a fraction of the stake. */
  rtp: number;
  /** Chance any single spin awards a bonus. */
  bonusChance: number;
  /** Expected free spins per round, retriggers included. */
  freeSpinsPerRound: number;
  /** Expected pay of one spin, in line-bet units. */
  spinUnits: number;
  /** The biggest single-line pay the cabinet can produce, in line-bet units. */
  topLine: number;
}

const cache = new WeakMap<SlotMachine, MachineReturn>();

export function exactReturn(machine: SlotMachine): MachineReturn {
  const cached = cache.get(machine);
  if (cached) return cached;

  const strips = stripsOf(machine);
  const lines = lineCountOf(machine);

  // Each reel's symbol distribution - one strip position is as likely as any other.
  const distribution = strips.map((strip) => {
    const counts = new Map<string, number>();
    for (const s of strip) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts.entries()].map(([s, n]) => [s, n / strip.length] as const);
  });

  // Exact EV of one payline, in line-bet units.
  let lineEV = 0;
  const walk = (reel: number, symbols: string[], p: number): void => {
    if (reel === strips.length) {
      const win = evaluateLine(machine, symbols);
      if (win) lineEV += p * win.units;
      return;
    }
    for (const [symbol, ps] of distribution[reel] as ReadonlyArray<readonly [string, number]>) {
      walk(reel + 1, [...symbols, symbol], p * ps);
    }
  };
  walk(0, [], 1);

  // Exact distribution of the number of scatters on screen, convolved reel by reel.
  let joint = new Map<number, number>([[0, 1]]);
  for (const strip of strips) {
    const perReel = Array.from({ length: ROWS + 1 }, () => 0);
    for (let stop = 0; stop < strip.length; stop += 1) {
      let n = 0;
      for (let o = 0; o < ROWS; o += 1) {
        if (strip[(stop + o) % strip.length] === SCATTER) n += 1;
      }
      perReel[n] = (perReel[n] as number) + 1;
    }
    const next = new Map<number, number>();
    for (const [total, p] of joint) {
      for (let n = 0; n <= ROWS; n += 1) {
        const pn = (perReel[n] as number) / strip.length;
        if (pn === 0) continue;
        next.set(total + n, (next.get(total + n) ?? 0) + p * pn);
      }
    }
    joint = next;
  }

  let scatterEV = 0;
  let bonusChance = 0;
  let freeSpinsPerSpin = 0;
  for (const [n, p] of joint) {
    if (n < 3) continue;
    const capped = Math.min(n, 5);
    scatterEV += p * (machine.scatterPays[capped] ?? 0) * lines;
    bonusChance += p;
    freeSpinsPerSpin += p * (machine.freeSpinAward[capped] ?? 0);
  }

  const spinUnits = lineEV * lines + scatterEV;
  /*
   * Each free spin can itself retrigger, so the expected number per round is the sum of
   * a geometric series. A rate at or above 1 would mean a bonus that never ends in
   * expectation - the engine's MAX_FREE_SPINS cap would stop it, but the economics
   * would already be broken, so it is worth refusing to quote a number for it.
   */
  if (freeSpinsPerSpin >= 1) {
    throw new Error(`${machine.id} awards free spins faster than it spends them`);
  }
  const freeSpinsPerRound = freeSpinsPerSpin / (1 - freeSpinsPerSpin);
  const roundEV = spinUnits + freeSpinsPerRound * spinUnits * machine.freeSpinMultiplier;

  const topLine = Math.max(
    ...Object.values(machine.paytable).map((pays) => pays[2]),
  );

  const result: MachineReturn = {
    rtp: roundEV / lines,
    bonusChance,
    freeSpinsPerRound,
    spinUnits,
    topLine,
  };
  cache.set(machine, result);
  return result;
}
