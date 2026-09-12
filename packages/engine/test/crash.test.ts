import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import {
  cashOutAt, crashTickFor, multiplierAtTick, resolveAt, settle, startCrash, TICK_MS,
  tickReaching, winsAt,
} from '../src/games/crash/index.js';
import { HOUSE_EDGE } from '../src/economy/chips.js';
import { MULTIPLIER_SCALE } from '../src/games/limbo/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'c'.repeat(64), clientSeed: 'crash', nonce });

describe('the curve', () => {
  it('starts at 1.00x and never dips below it', () => {
    expect(multiplierAtTick(0)).toBe(MULTIPLIER_SCALE);
    expect(multiplierAtTick(-5)).toBe(MULTIPLIER_SCALE);
  });

  it('climbs monotonically', () => {
    let previous = 0;
    for (let tick = 0; tick < 400; tick += 1) {
      const value = multiplierAtTick(tick);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is an integer number of hundredths at every tick', () => {
    for (let tick = 0; tick < 200; tick += 1) {
      expect(Number.isInteger(multiplierAtTick(tick))).toBe(true);
    }
  });

  it('grows at pysino s rate', () => {
    // 1.07 ** (seconds * 4). At 2.5s that is 1.07**10 = 1.967x.
    const tick = Math.round(2500 / TICK_MS);
    expect(multiplierAtTick(tick)).toBe(Math.floor(1.07 ** 10 * 100));
  });
});

describe('tick boundaries', () => {
  it('finds the exact first tick that reaches a value', () => {
    // The whole reason this module exists: the boundary must be exact, not
    // "whatever the closed form happened to round to".
    for (let point = 100; point < 5000; point += 7) {
      const tick = tickReaching(point);
      expect(multiplierAtTick(tick)).toBeGreaterThanOrEqual(point);
      if (tick > 0) expect(multiplierAtTick(tick - 1)).toBeLessThan(point);
    }
  });

  it('dies on the first tick strictly past the crash point', () => {
    for (let point = 100; point < 5000; point += 13) {
      const tick = crashTickFor(point);
      expect(multiplierAtTick(tick)).toBeGreaterThan(point);
      expect(multiplierAtTick(tick - 1)).toBeLessThanOrEqual(point);
    }
  });

  it('gives a 1.00x round exactly one tick to cash out on', () => {
    // A crash point that floors to 1.00x is a push, not a confiscation: the player
    // can still take 1.00x and get their stake back.
    expect(crashTickFor(MULTIPLIER_SCALE)).toBe(1);
    expect(multiplierAtTick(0)).toBe(MULTIPLIER_SCALE);
  });
});

describe('playing a round', () => {
  it('pays the multiplier you cashed out at', () => {
    const round = startCrash(100, stream(1));
    // Cash out one tick before the crash, whatever that is for this seed.
    const safe = Math.max(0, round.crashTick - 1);
    const done = cashOutAt(round, safe);
    expect(done.state).toBe('cashed');
    expect(settle(done).payout).toBe(Math.floor(100 * (multiplierAtTick(safe) / 100)));
  });

  it('pays nothing if you cash out at or after the crash', () => {
    const round = startCrash(100, stream(2));
    const done = cashOutAt(round, round.crashTick);
    expect(done.state).toBe('crashed');
    expect(settle(done).payout).toBe(0);
  });

  it('treats losing the race as a crash, not an error', () => {
    const round = startCrash(100, stream(3));
    expect(() => cashOutAt(round, round.crashTick + 500)).not.toThrow();
    expect(cashOutAt(round, round.crashTick + 500).state).toBe('crashed');
  });

  it('never re-settles a finished round', () => {
    const round = startCrash(100, stream(4));
    const cashed = cashOutAt(round, 0);
    expect(cashOutAt(cashed, 999)).toEqual(cashed);
    expect(resolveAt(cashed, 999)).toEqual(cashed);
  });

  it('is reproducible from the seed', () => {
    expect(startCrash(100, stream(7)).crashPoint).toBe(startCrash(100, stream(7)).crashPoint);
  });
});

describe('auto cash-out', () => {
  it('pays exactly the target, never the tick s overshoot', () => {
    // The curve only takes certain discrete values, so the tick that first reaches
    // 2.00x is actually at 2.02x. Paying that would be free money.
    let round = startCrash(100, stream(0), 200);
    for (let nonce = 1; round.crashPoint <= 250; nonce += 1) {
      round = startCrash(100, stream(nonce), 200);
    }
    const done = resolveAt(round, round.crashTick + 10);
    expect(done.state).toBe('cashed');
    expect(done.cashedMultiplier).toBe(200);
    expect(multiplierAtTick(tickReaching(200))).toBeGreaterThan(200);
    expect(settle(done).payout).toBe(200);
  });

  it('does not fire above the crash point', () => {
    let round = startCrash(100, stream(0), 10_000);
    for (let nonce = 1; round.crashPoint >= 10_000; nonce += 1) {
      round = startCrash(100, stream(nonce), 10_000);
    }
    expect(resolveAt(round, round.crashTick).state).toBe('crashed');
    expect(settle(resolveAt(round, round.crashTick)).payout).toBe(0);
  });

  it('protects a disconnected player who set a target', () => {
    // The target is honoured from the round's own state, so a client that vanishes
    // mid-round still gets the cash-out it asked for before the round began.
    let round = startCrash(500, stream(0), 150);
    for (let nonce = 1; round.crashPoint <= 200; nonce += 1) {
      round = startCrash(500, stream(nonce), 150);
    }
    const abandoned = resolveAt(round, 100_000);
    expect(abandoned.state).toBe('cashed');
    expect(settle(abandoned).payout).toBe(750);
  });
});

describe('the house edge', () => {
  /**
   * The identity the whole game rests on: `P(crashPoint >= v) = (1 - edge) / (v / 100)`.
   * Paying `v` on exactly that event gives an expected return of `1 - edge` at every
   * target, so the edge is charged once and only once.
   *
   * This is a Bernoulli trial rather than a fat-tailed payout, so it converges fast
   * enough to assert tightly - unlike the RTP itself.
   */
  it('always survives to 1.00x, which is a push and nothing more', () => {
    // The crash point is clamped at 1.00x, so the identity below starts at 1.01x.
    // Cashing out at 1.00x returns exactly the stake: a player can sit at that target
    // forever and neither pay the edge nor gain a chip, which is the same as not
    // playing. Worth pinning so nobody "fixes" the clamp into a confiscation.
    for (let nonce = 0; nonce < 500; nonce += 1) {
      const round = startCrash(100, stream(nonce));
      expect(round.crashPoint).toBeGreaterThanOrEqual(MULTIPLIER_SCALE);
      expect(settle(cashOutAt(round, 0)).payout).toBe(100);
    }
  });

  it('survives to v with probability exactly 0.99 / v', () => {
    const rounds = 120_000;
    for (const value of [101, 150, 200, 500, 1000]) {
      let survived = 0;
      for (let nonce = 0; nonce < rounds; nonce += 1) {
        if (winsAt(startCrash(100, stream(nonce)).crashPoint, value)) survived += 1;
      }
      const expected = (1 - HOUSE_EDGE) / (value / MULTIPLIER_SCALE);
      const sigma = Math.sqrt((expected * (1 - expected)) / rounds);
      expect(Math.abs(survived / rounds - expected)).toBeLessThan(4 * sigma);
    }
  });

  it('pushes rather than confiscates when the curve dies at 1.00x', () => {
    // Flooring to hundredths means every draw in [1.00, 1.01) becomes a crash point of
    // exactly 1.00x - which is 2/101 of rounds, not `edge`. Treating those as total
    // losses would roughly double the house edge by accident.
    let round = startCrash(100, stream(0));
    for (let nonce = 1; round.crashPoint !== MULTIPLIER_SCALE; nonce += 1) {
      round = startCrash(100, stream(nonce));
    }
    const done = cashOutAt(round, 0);
    expect(done.state).toBe('cashed');
    expect(settle(done).payout).toBe(100);
  });

  it('returns ~99% at every auto cash-out target', () => {
    const rounds = 40_000;
    for (const target of [150, 200, 500, 1000]) {
      let staked = 0;
      let returned = 0;
      for (let nonce = 0; nonce < rounds; nonce += 1) {
        const round = startCrash(1000, stream(nonce), target);
        staked += 1000;
        returned += settle(resolveAt(round, 1_000_000)).payout;
      }
      const rtp = returned / staked;
      // Error bar grows with the target: at 10x only ~1 in 10 rounds pays.
      const tolerance = 0.04 * Math.sqrt(target / 150);
      expect(Math.abs(rtp - (1 - HOUSE_EDGE))).toBeLessThan(tolerance);
    }
  });

  it('pays the same expectation whichever target you pick', () => {
    // The defining property of the distribution. Picking 10x instead of 1.5x changes
    // variance, never edge - which is what makes the game honest rather than a trap.
    const rounds = 40_000;
    const rtps = [150, 300, 600].map((target) => {
      let returned = 0;
      for (let nonce = 0; nonce < rounds; nonce += 1) {
        returned += settle(resolveAt(startCrash(1000, stream(nonce), target), 1e9)).payout;
      }
      return returned / (rounds * 1000);
    });
    for (const rtp of rtps) expect(rtp).toBeCloseTo(rtps[0] as number, 1);
  });
});
