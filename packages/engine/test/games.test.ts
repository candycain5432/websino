import { FairStream } from '@websino/fair';
import { describe, expect, it } from 'vitest';

import { assertValidBet, chipsForAmount, HOUSE_EDGE, InvalidBetError, payoutFor } from '../src/economy/chips.js';
import { dice, multiplierFor, winChanceOf, type DiceConfig } from '../src/games/dice/index.js';
import { drawMultiplier, limbo } from '../src/games/limbo/index.js';

const streamFor = (nonce: number, clientSeed = 'rtp'): FairStream =>
  new FairStream({ serverSeed: 'c'.repeat(64), clientSeed, nonce });

describe('chip maths', () => {
  it('floors payouts so the fraction goes to the house', () => {
    expect(payoutFor(100, 1.985)).toBe(198);
    expect(payoutFor(3, 1.5)).toBe(4);
    expect(payoutFor(100, 0)).toBe(0);
  });

  it('never loses more than one chip to rounding', () => {
    for (let bet = 1; bet <= 500; bet += 1) {
      for (const m of [1.01, 1.5, 1.98, 2.0, 3.33, 9.9]) {
        expect(bet * m - payoutFor(bet, m)).toBeLessThan(1);
      }
    }
  });

  it('rejects illegal stakes', () => {
    expect(() => assertValidBet(1.5, 1000)).toThrow(InvalidBetError);
    expect(() => assertValidBet(0, 1000)).toThrow(InvalidBetError);
    expect(() => assertValidBet(50, 10)).toThrow(/not enough/);
    expect(() => assertValidBet(10, 1000)).not.toThrow();
  });

  it('breaks an amount into chip denominations', () => {
    expect(chipsForAmount(3786)).toEqual([
      { denomination: 2500, count: 1 }, { denomination: 500, count: 2 },
      { denomination: 100, count: 2 }, { denomination: 25, count: 3 },
      { denomination: 5, count: 2 }, { denomination: 1, count: 1 },
    ]);
    expect(chipsForAmount(0)).toEqual([]);
  });
});

describe('dice', () => {
  it('pays (1 - edge) / winChance, so EV is flat across every target', () => {
    for (const target of [1000, 2500, 5000, 7500, 9000]) {
      for (const direction of ['over', 'under'] as const) {
        const config: DiceConfig = { target, direction };
        if (winChanceOf(config) < 0.01 || winChanceOf(config) > 0.95) continue;
        const ev = winChanceOf(config) * multiplierFor(config);
        expect(ev).toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    }
  });

  it('counts winning outcomes correctly at the boundaries', () => {
    // "over 5000" wins on 5001..9999 -> 4999 of 10000.
    expect(winChanceOf({ target: 5000, direction: 'over' })).toBeCloseTo(0.4999, 10);
    // "under 5000" wins on 0..4999 -> 5000 of 10000.
    expect(winChanceOf({ target: 5000, direction: 'under' })).toBeCloseTo(0.5, 10);
  });

  it('refuses degenerate targets', () => {
    expect(() => dice.validateConfig({ target: 9999, direction: 'over' })).toThrow(/win chance/);
    expect(() => dice.validateConfig({ target: 0, direction: 'under' })).toThrow(/win chance/);
    expect(() => dice.validateConfig({ target: -1, direction: 'over' })).toThrow();
    expect(() => dice.validateConfig({ target: 1.5, direction: 'over' })).toThrow();
  });

  it('consumes exactly one float per round', () => {
    const stream = streamFor(1);
    dice.play(dice.defaultConfig, 100, stream);
    expect(stream.bytesUsed).toBe(4);
  });

  it('returns ~99% over a long run, at several targets', () => {
    for (const config of [
      { target: 5000, direction: 'over' as const },
      { target: 9000, direction: 'over' as const },
      { target: 2000, direction: 'under' as const },
    ]) {
      const rounds = 60_000;
      let staked = 0;
      let returned = 0;
      for (let n = 0; n < rounds; n += 1) {
        staked += 100;
        returned += dice.play(config, 100, streamFor(n, `dice-${config.target}`)).payout;
      }
      const rtp = returned / staked;
      // Standard error at this sample size is well under 1%; 0.96-1.02 is a
      // comfortable band that still catches a real maths error.
      expect(rtp).toBeGreaterThan(0.96);
      expect(rtp).toBeLessThan(1.02);
    }
  });
});

describe('limbo', () => {
  it('never draws below 1.00x', () => {
    for (let n = 0; n < 5_000; n += 1) {
      expect(drawMultiplier(streamFor(n, 'floor'))).toBeGreaterThanOrEqual(100);
    }
  });

  it('busts at exactly 1.00x about as often as the house edge', () => {
    const trials = 40_000;
    let busts = 0;
    for (let n = 0; n < trials; n += 1) {
      if (drawMultiplier(streamFor(n, 'bust')) === 100) busts += 1;
    }
    // Flooring to hundredths folds the 1.00-1.01 band in too, so this sits a
    // little above the bare 1% edge - same as pysino's crash.
    expect(busts / trials).toBeGreaterThan(0.008);
    expect(busts / trials).toBeLessThan(0.03);
  });

  it('returns ~99% at every target, which is the whole point of the distribution', () => {
    for (const target of [150, 200, 500, 1000]) {
      const trials = 60_000;
      let staked = 0;
      let returned = 0;
      for (let n = 0; n < trials; n += 1) {
        staked += 100;
        returned += limbo.play({ target }, 100, streamFor(n, `limbo-${target}`)).payout;
      }
      const rtp = returned / staked;
      expect(rtp).toBeGreaterThan(0.94);
      expect(rtp).toBeLessThan(1.04);
    }
  });

  it('wins exactly when the result reaches the target', () => {
    const stream = streamFor(3, 'edge');
    const result = drawMultiplier(streamFor(3, 'edge'));
    const outcome = limbo.play({ target: result }, 100, stream);
    expect(outcome.detail.won).toBe(true); // target === result must win
  });

  it('refuses targets outside the permitted range', () => {
    expect(() => limbo.validateConfig({ target: 100 })).toThrow();
    expect(() => limbo.validateConfig({ target: 1.5 })).toThrow();
  });

  it('consumes exactly one float per round', () => {
    const stream = streamFor(1);
    limbo.play(limbo.defaultConfig, 100, stream);
    expect(stream.bytesUsed).toBe(4);
  });
});

describe('reproducibility', () => {
  it('replays a round exactly from its three strings', () => {
    const config = { target: 7500, direction: 'over' as const };
    const first = dice.play(config, 250, streamFor(99, 'replay'));
    const again = dice.play(config, 250, streamFor(99, 'replay'));
    expect(again).toEqual(first);
  });
});
