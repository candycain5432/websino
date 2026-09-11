/**
 * The non-fair source: bots, hints, cosmetic jitter. Deliberately cannot be passed where
 * a `FairSource` is required (see types.ts).
 *
 * Seedable so bot behaviour is reproducible in tests - a plain Math.random would make
 * "tight-aggressive beats maniac over 50k hands" untestable.
 */

import type { CasualSource } from './types.js';

/** mulberry32 - small, fast, good enough for anything that isn't money. */
export function createCasualSource(seed = (Math.random() * 0xffffffff) >>> 0): CasualSource {
  let state = seed >>> 0;

  const nextFloat = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const randBelow = (n: number): number => Math.floor(nextFloat() * n);

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = randBelow(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  };

  return {
    kind: 'casual',
    nextFloat,
    randBelow,
    shuffle,
    sample: <T,>(items: readonly T[], k: number): T[] => shuffle(items).slice(0, k),
    pick: <T,>(items: readonly T[]): T => items[randBelow(items.length)] as T,
  };
}
