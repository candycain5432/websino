/**
 * Plinko and the wheel.
 *
 * Both derive their payout tables rather than shipping hand-tuned ones, so the tests
 * that matter are the *exact* ones: the return to player is computable in closed form
 * for every configuration, and is pinned here so a tuning change cannot drift it
 * quietly. No simulation is used for the headline figures - a binomial with a 1-in-65536
 * tail and a wheel with a 1-in-50 jackpot are both far too fat-tailed for a sampled
 * mean to say anything useful at any run length this suite could afford.
 */

import { FairStream } from '@websino/fair';
import { describe, expect, it } from 'vitest';

import { HOUSE_EDGE } from '../src/economy/chips.js';
import {
  plinko, bucketChance, multipliersFor, ROW_CHOICES, RISK_BASE,
  returnToPlayer as plinkoRtp, type Risk, type Rows,
} from '../src/games/plinko/index.js';
import {
  wheel, wheelFor, SEGMENT_CHOICES, RISK_SHAPE,
  returnToPlayer as wheelRtp, type Segments, type WheelRisk,
} from '../src/games/wheel/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'c3'.repeat(32), clientSeed: 'boards', nonce });

const RISKS: Risk[] = ['low', 'medium', 'high'];
const WHEEL_RISKS: WheelRisk[] = ['low', 'medium', 'high'];

// ----------------------------------------------------------------------- plinko --

describe('plinko buckets', () => {
  it('is a binomial, so the chances sum to exactly one', () => {
    for (const rows of ROW_CHOICES) {
      let total = 0;
      for (let k = 0; k <= rows; k += 1) total += bucketChance(rows, k);
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('makes the edges as rare as a coin landing the same way every time', () => {
    // The reason the edge buckets can pay what they do, stated as a number.
    expect(bucketChance(16, 0)).toBe(1 / 65_536);
    expect(bucketChance(16, 16)).toBe(1 / 65_536);
    expect(bucketChance(8, 4)).toBe(70 / 256);
  });
});

describe('plinko payout tables', () => {
  it('is symmetric, with the centre paying least', () => {
    for (const rows of ROW_CHOICES) {
      for (const risk of RISKS) {
        const table = multipliersFor({ rows: rows as Rows, risk });
        expect(table).toHaveLength(rows + 1);
        for (let k = 0; k <= rows; k += 1) {
          expect(table[k]).toBe(table[rows - k]);
        }
        expect(Math.min(...table)).toBe(table[rows / 2]);
      }
    }
  });

  it('pays more at the edges the riskier the board', () => {
    for (const rows of ROW_CHOICES) {
      const low = Math.max(...multipliersFor({ rows: rows as Rows, risk: 'low' }));
      const medium = Math.max(...multipliersFor({ rows: rows as Rows, risk: 'medium' }));
      const high = Math.max(...multipliersFor({ rows: rows as Rows, risk: 'high' }));
      expect(low).toBeLessThan(medium);
      expect(medium).toBeLessThan(high);
    }
    expect(RISK_BASE.low).toBeLessThan(RISK_BASE.medium);
    expect(RISK_BASE.medium).toBeLessThan(RISK_BASE.high);
  });

  it('returns within a tenth of a point of 99% on every board', () => {
    for (const rows of ROW_CHOICES) {
      for (const risk of RISKS) {
        const rtp = plinkoRtp({ rows: rows as Rows, risk });
        expect(Math.abs(rtp - (1 - HOUSE_EDGE))).toBeLessThan(0.0015);
      }
    }
  });

  /**
   * The exact figures, to four decimals.
   *
   * The band above would still pass if someone nudged a base and shifted every board by
   * a tenth of a point. This will not: changing the tuning has to mean changing these
   * numbers, deliberately, in the same commit.
   */
  it('has exactly these returns, so tuning cannot drift unnoticed', () => {
    const actual: Record<string, string> = {};
    for (const rows of ROW_CHOICES) {
      for (const risk of RISKS) {
        actual[`${rows}-${risk}`] = (plinkoRtp({ rows: rows as Rows, risk }) * 100).toFixed(4);
      }
    }
    expect(actual).toEqual({
      '8-low': '99.0000', '8-medium': '98.9766', '8-high': '99.0625',
      '12-low': '99.1201', '12-medium': '98.9624', '12-high': '98.9980',
      '16-low': '99.0561', '16-medium': '98.9441', '16-high': '99.0651',
    });
  });

  it('has a headline multiplier worth playing for at each risk', () => {
    expect(Math.max(...multipliersFor({ rows: 16, risk: 'low' }))).toBe(8.49);
    expect(Math.max(...multipliersFor({ rows: 16, risk: 'medium' }))).toBe(40.66);
    expect(Math.max(...multipliersFor({ rows: 16, risk: 'high' }))).toBe(225.89);
  });
});

describe('dropping a ball', () => {
  it('takes exactly one draw per row and lands where the path says', () => {
    for (const rows of ROW_CHOICES) {
      const source = stream(rows);
      const before = source.bytesUsed;
      const result = plinko.play({ rows: rows as Rows, risk: 'medium' }, 100, source);

      expect(result.detail.path).toHaveLength(rows);
      expect(result.detail.bucket).toBe(result.detail.path.filter(Boolean).length);
      // 4 bytes per float, one float per row - the documented draw order, asserted.
      expect(source.bytesUsed - before).toBe(rows * 4);
    }
  });

  it('pays the bucket it landed in, and says which table it used', () => {
    const result = plinko.play({ rows: 12, risk: 'high' }, 200, stream(5));
    const table = multipliersFor({ rows: 12, risk: 'high' });
    expect(result.detail.multipliers).toEqual(table);
    expect(result.multiplier).toBe(table[result.detail.bucket]);
    expect(result.payout).toBe(Math.floor(200 * result.multiplier));
  });

  it('replays identically from the same seed', () => {
    const a = plinko.play({ rows: 16, risk: 'low' }, 50, stream(99));
    const b = plinko.play({ rows: 16, risk: 'low' }, 50, stream(99));
    expect(a.detail.path).toEqual(b.detail.path);
    expect(a.payout).toBe(b.payout);
  });

  it('refuses a board it does not offer', () => {
    expect(() => plinko.validateConfig({ rows: 9 as Rows, risk: 'low' })).toThrow(/rows/);
    expect(() => plinko.validateConfig({ rows: 8, risk: 'reckless' as Risk })).toThrow(/risk/);
  });
});

// ------------------------------------------------------------------------ wheel --

describe('the wheel', () => {
  it('returns essentially exactly 99% on every wheel', () => {
    for (const segments of SEGMENT_CHOICES) {
      for (const risk of WHEEL_RISKS) {
        const rtp = wheelRtp({ segments: segments as Segments, risk });
        expect(Math.abs(rtp - (1 - HOUSE_EDGE))).toBeLessThan(0.0015);
      }
    }
  });

  it('has exactly these returns, so tuning cannot drift unnoticed', () => {
    const actual: Record<string, string> = {};
    for (const segments of SEGMENT_CHOICES) {
      for (const risk of WHEEL_RISKS) {
        actual[`${segments}-${risk}`] =
          (wheelRtp({ segments: segments as Segments, risk }) * 100).toFixed(3);
      }
    }
    expect(actual).toEqual({
      '10-low': '98.900', '10-medium': '99.000', '10-high': '99.000',
      '20-low': '99.000', '20-medium': '99.050', '20-high': '99.000',
      '30-low': '99.000', '30-medium': '99.000', '30-high': '99.033',
      '40-low': '99.000', '40-medium': '99.000', '40-high': '98.975',
      '50-low': '99.000', '50-medium': '99.000', '50-high': '99.000',
    });
  });

  it('pays on fewer segments and pays more as risk climbs', () => {
    for (const segments of SEGMENT_CHOICES) {
      const paying = (risk: WheelRisk): number =>
        wheelFor({ segments: segments as Segments, risk }).filter((v) => v > 0).length;
      const best = (risk: WheelRisk): number =>
        Math.max(...wheelFor({ segments: segments as Segments, risk }));

      expect(paying('low')).toBeGreaterThan(paying('medium'));
      expect(paying('medium')).toBeGreaterThan(paying('high'));
      expect(best('low')).toBeLessThan(best('medium'));
      expect(best('medium')).toBeLessThan(best('high'));
    }
    expect(RISK_SHAPE.low.winners).toBeGreaterThan(RISK_SHAPE.high.winners);
  });

  /**
   * The ceiling every one-spin wheel has, asserted rather than assumed.
   *
   * Segments are equally likely, so the payouts average `1 - edge`; no segment can pay
   * more than `segments * (1 - edge)` even if every other one is a blank. Worth a test
   * because it is the answer to "can we have a 1000x wheel" - not without more segments.
   */
  it('cannot pay more on one segment than the whole wheel is worth', () => {
    for (const segments of SEGMENT_CHOICES) {
      for (const risk of WHEEL_RISKS) {
        const board = wheelFor({ segments: segments as Segments, risk });
        expect(Math.max(...board)).toBeLessThanOrEqual(segments * (1 - HOUSE_EDGE));
      }
    }
  });

  it('spreads the paying segments around the rim rather than bunching them', () => {
    // A wheel with all its prizes adjacent is not a wheel, it is a pie chart.
    const board = wheelFor({ segments: 30, risk: 'medium' });
    const paying = board.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const gaps = paying.slice(1).map((at, i) => at - (paying[i] as number));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('takes exactly one draw, and pays the segment it stopped on', () => {
    const source = stream(21);
    const before = source.bytesUsed;
    const result = wheel.play({ segments: 30, risk: 'medium' }, 100, source);

    expect(source.bytesUsed - before).toBe(4);
    expect(result.detail.index).toBeGreaterThanOrEqual(0);
    expect(result.detail.index).toBeLessThan(30);
    expect(result.multiplier).toBe(result.detail.wheel[result.detail.index]);
    expect(result.detail.won).toBe(result.multiplier > 0);
    expect(result.payout).toBe(result.multiplier > 0 ? Math.floor(100 * result.multiplier) : 0);
  });

  it('refuses a wheel it does not offer', () => {
    expect(() => wheel.validateConfig({ segments: 7 as Segments, risk: 'low' })).toThrow(/segments/);
    expect(() => wheel.validateConfig({ segments: 10, risk: 'wild' as WheelRisk })).toThrow(/risk/);
  });
});

// ------------------------------------------------------------------ both, over time --

describe('a long run', () => {
  /**
   * A sanity check, not the RTP assertion.
   *
   * The exact figures above are the real test; this only catches a play() that pays
   * something wildly unrelated to its own table - a wired-up-wrong bug rather than a
   * tuning one. The bound is deliberately loose because the distributions are fat-tailed.
   */
  it('pays out in the region its own table says it should', () => {
    for (const [label, run] of [
      ['plinko', (n: number) => plinko.play({ rows: 8, risk: 'low' }, 100, stream(n)).payout],
      ['wheel', (n: number) => wheel.play({ segments: 20, risk: 'low' }, 100, stream(n)).payout],
    ] as const) {
      let returned = 0;
      const rounds = 4_000;
      for (let n = 0; n < rounds; n += 1) returned += run(n);
      const rtp = returned / (rounds * 100);
      expect(rtp, label).toBeGreaterThan(0.8);
      expect(rtp, label).toBeLessThan(1.2);
    }
  });
});
