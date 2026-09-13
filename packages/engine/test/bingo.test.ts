/**
 * Bingo.
 *
 * The interesting thing to test is that the paytable is *derived*. Bingo looks like a
 * game you have to simulate - twelve overlapping lines on a card, seventy-five balls,
 * "when does the first line complete" - and it is not. The whole distribution comes out
 * of an inclusion-exclusion over the card's geometry, which means the return to player is
 * an exact number, pinned here, rather than a figure somebody measured once.
 *
 * The distribution is also checked *against the game*: `settleCard` and `exactOdds` are
 * two independent statements about the same thing, so a long run of real rounds landing
 * on the predicted distribution is a genuine cross-check rather than a restatement.
 */

import { FairStream } from '@websino/fair';
import { describe, expect, it } from 'vitest';

import {
  BALLS_DRAWN, CARD_SIZE, COLUMN_LETTERS, COLUMN_RANGE, LINES, MAX_CARDS, POOL, TIERS,
  chanceCompleteBy, drawBalls, exactOdds, makeCard, multiplierForBall, payoutForCard,
  returnToPlayer, settleCard, type BingoCard,
} from '../src/games/bingo/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'b9'.repeat(32), clientSeed: 'hall', nonce });

// ------------------------------------------------------------------------- cards --

describe('a bingo card', () => {
  it('takes its numbers from each column\'s own range', () => {
    for (let n = 0; n < 50; n += 1) {
      const card = makeCard(stream(n));
      expect(card).toHaveLength(CARD_SIZE);
      for (let column = 0; column < CARD_SIZE; column += 1) {
        const low = column * COLUMN_RANGE + 1;
        for (let row = 0; row < CARD_SIZE; row += 1) {
          const value = (card[row] as ReadonlyArray<number | null>)[column];
          if (value === null) continue;
          expect(value).toBeGreaterThanOrEqual(low);
          expect(value).toBeLessThan(low + COLUMN_RANGE);
        }
      }
    }
  });

  it('has a free centre and twenty-four distinct numbers', () => {
    const card = makeCard(stream(7));
    expect((card[2] as ReadonlyArray<number | null>)[2]).toBeNull();

    const numbers = card.flat().filter((v): v is number => v !== null);
    expect(numbers).toHaveLength(24);
    expect(new Set(numbers).size).toBe(24);
  });

  it('costs one sample of five per column, in B-I-N-G-O order', () => {
    const source = stream(3);
    const before = source.bytesUsed;
    const card = makeCard(source);

    // Five columns, five numbers each, four bytes a draw - the documented order. A
    // rejection in the sampler could push this up, so the floor is what is asserted.
    expect(source.bytesUsed - before).toBeGreaterThanOrEqual(CARD_SIZE * CARD_SIZE * 4);
    expect(COLUMN_LETTERS).toHaveLength(CARD_SIZE);
    // The first column is B, so every number in it is 1-15. Ordering the draws any other
    // way would still produce a legal-looking card, which is why this is worth pinning.
    for (let row = 0; row < CARD_SIZE; row += 1) {
      expect((card[row] as ReadonlyArray<number | null>)[0]).toBeLessThanOrEqual(COLUMN_RANGE);
    }
  });

  it('replays identically from the same seed', () => {
    expect(makeCard(stream(11))).toEqual(makeCard(stream(11)));
    expect(makeCard(stream(11))).not.toEqual(makeCard(stream(12)));
  });
});

describe('the ball sequence', () => {
  it('calls fifty of the seventy-five, with no repeats', () => {
    const balls = drawBalls(stream(1));
    expect(balls).toHaveLength(BALLS_DRAWN);
    expect(new Set(balls).size).toBe(BALLS_DRAWN);
    for (const ball of balls) {
      expect(ball).toBeGreaterThanOrEqual(1);
      expect(ball).toBeLessThanOrEqual(POOL);
    }
  });
});

// ----------------------------------------------------------------------- settling --

describe('settling a card', () => {
  it('has twelve lines: five rows, five columns, two diagonals', () => {
    expect(LINES).toHaveLength(2 * CARD_SIZE + 2);
    for (const line of LINES) expect(line).toHaveLength(CARD_SIZE);
  });

  it('pays the earliest ball any line completed on', () => {
    const card: BingoCard = [
      [1, 16, 31, 46, 61],
      [2, 17, 32, 47, 62],
      [3, 18, null, 48, 63],
      [4, 19, 33, 49, 64],
      [5, 20, 34, 50, 65],
    ];

    // The middle row needs only four balls, the free centre standing in for the fifth.
    const result = settleCard(card, [3, 99, 18, 48, 63, 1, 2, 4, 5]);
    expect(result.ball).toBe(5);
    expect(result.line).toEqual([[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]]);
    expect(result.multiplier).toBe(10);
  });

  it('takes the free centre as already covered', () => {
    const card = makeCard(stream(21));
    // A diagonal through the centre needs four numbers, not five.
    const diagonal = [0, 1, 3, 4].map(
      (i) => (card[i] as ReadonlyArray<number | null>)[i] as number,
    );
    const result = settleCard(card, diagonal);
    expect(result.ball).toBe(4);
  });

  it('pays nothing for a card that never completes', () => {
    const card = makeCard(stream(31));
    const numbers = new Set(card.flat().filter((v): v is number => v !== null));
    // Call only balls the card does not hold: nothing can complete.
    const balls = Array.from({ length: POOL }, (_, i) => i + 1)
      .filter((n) => !numbers.has(n))
      .slice(0, BALLS_DRAWN);

    const result = settleCard(card, balls);
    expect(result.ball).toBeNull();
    expect(result.line).toEqual([]);
    expect(result.multiplier).toBe(0);
    expect(payoutForCard(100, result)).toBe(0);
  });

  it('never completes before the fourth ball', () => {
    // The fastest possible line is the four numbers either side of the free centre.
    for (let n = 0; n < 400; n += 1) {
      const source = stream(n);
      const card = makeCard(source);
      const result = settleCard(card, drawBalls(source));
      if (result.ball !== null) expect(result.ball).toBeGreaterThanOrEqual(4);
    }
    expect(chanceCompleteBy(3)).toBe(0);
    expect(chanceCompleteBy(4)).toBeGreaterThan(0);
  });

  it('floors the payout, so the fraction stays with the house', () => {
    expect(payoutForCard(10, { ball: 41, line: [], multiplier: 0.75 })).toBe(7);
    expect(payoutForCard(100, { ball: 12, line: [], multiplier: 10 })).toBe(1_000);
    expect(() => payoutForCard(0, { ball: 12, line: [], multiplier: 10 })).toThrow(/positive/);
  });
});

// --------------------------------------------------------------------- the maths --

describe('the completion distribution', () => {
  it('is a distribution: it sums to one over all seventy-five balls', () => {
    const { byBall } = exactOdds();
    const total = byBall.reduce((sum, p) => sum + p, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  /**
   * Monotonic *exactly*, not to within noise.
   *
   * The alternating sum behind it cancels 4,095 large terms down to a number below one,
   * so in doubles it overshot 1.0 at ball 74 - and a cumulative that can go down is a
   * per-ball chance that can come out negative. Computing the sum as an exact fraction
   * removes the possibility rather than bounding it, which is what this asserts.
   */
  it('is monotonic - more balls can only help', () => {
    for (let ball = 1; ball <= POOL; ball += 1) {
      expect(chanceCompleteBy(ball)).toBeGreaterThanOrEqual(chanceCompleteBy(ball - 1));
    }
    expect(chanceCompleteBy(0)).toBe(0);
    // Every card is complete once every number on it has been called.
    expect(chanceCompleteBy(POOL)).toBe(1);
  });

  it('has no negative chance anywhere in it', () => {
    for (const p of exactOdds().byBall) expect(p).toBeGreaterThanOrEqual(0);
  });

  /**
   * The tier probabilities and the return, exactly.
   *
   * This is the test that makes the paytable a decision rather than a guess: changing a
   * multiplier or a band edge has to mean changing these numbers, in the same commit,
   * on purpose.
   */
  it('has exactly these odds and this return', () => {
    const { byTier, missChance, rtp, meanBalls } = exactOdds();

    const table = TIERS.map((tier, i) => ({
      upTo: tier.upTo,
      pays: tier.multiplier,
      chance: ((byTier[i] as number) * 100).toFixed(3),
    }));

    expect(table).toEqual([
      { upTo: 20, pays: 10, chance: '2.287' },
      { upTo: 27, pays: 2.5, chance: '6.753' },
      { upTo: 33, pays: 1.25, chance: '12.410' },
      { upTo: 39, pays: 1, chance: '19.362' },
      { upTo: 45, pays: 0.75, chance: '23.195' },
      { upTo: 50, pays: 0.4, chance: '17.431' },
    ]);

    expect((missChance * 100).toFixed(3)).toBe('18.561');
    expect((rtp * 100).toFixed(4)).toBe('99.0014');
    expect(meanBalls.toFixed(3)).toBe('41.369');
  });

  it('returns within a tenth of a point of 99%', () => {
    expect(Math.abs(returnToPlayer() - 0.99)).toBeLessThan(0.001);
  });

  it('pays less the longer a card takes, and nothing after the last ball', () => {
    for (let i = 1; i < TIERS.length; i += 1) {
      expect(TIERS[i]?.multiplier).toBeLessThan(TIERS[i - 1]?.multiplier as number);
      expect(TIERS[i]?.upTo).toBeGreaterThan(TIERS[i - 1]?.upTo as number);
    }
    expect(multiplierForBall(BALLS_DRAWN)).toBeGreaterThan(0);
    expect(multiplierForBall(BALLS_DRAWN + 1)).toBe(0);
    expect(multiplierForBall(null)).toBe(0);
  });

  it('gives roughly four cards in five something back', () => {
    const hitRate = 1 - exactOdds().missChance;
    expect(hitRate).toBeGreaterThan(0.8);
    expect(hitRate).toBeLessThan(0.85);
  });
});

/**
 * The engine and the maths, checked against each other.
 *
 * `settleCard` walks a real card against a real ball sequence; `exactOdds` never looks at
 * a card at all. They are independent implementations of the same claim, so agreement
 * over a long run is evidence, not a tautology - and a disagreement would mean one of the
 * two is wrong about what a bingo card is.
 */
describe('the maths and the game agree', () => {
  it('lands on the predicted return over a long run', () => {
    const rounds = 30_000;
    const stake = 100;
    let staked = 0;
    let returned = 0;
    let hits = 0;

    for (let n = 0; n < rounds; n += 1) {
      const source = stream(n + 1_000);
      const card = makeCard(source);
      const result = settleCard(card, drawBalls(source));
      staked += stake;
      returned += payoutForCard(stake, result);
      if (result.ball !== null) hits += 1;
    }

    const { rtp, missChance } = exactOdds();
    // Three standard errors on 30k rounds of a distribution whose top tier is 10x.
    expect(Math.abs(returned / staked - rtp)).toBeLessThan(0.02);
    expect(Math.abs(hits / rounds - (1 - missChance))).toBeLessThan(0.01);
  });

  it('matches the predicted completion ball, band by band', () => {
    const rounds = 30_000;
    const observed = TIERS.map(() => 0);
    let missed = 0;

    for (let n = 0; n < rounds; n += 1) {
      const source = stream(n + 500_000);
      const result = settleCard(makeCard(source), drawBalls(source));
      if (result.ball === null) {
        missed += 1;
        continue;
      }
      const tier = TIERS.findIndex((t) => (result.ball as number) <= t.upTo);
      observed[tier] = (observed[tier] as number) + 1;
    }

    const { byTier, missChance } = exactOdds();
    for (let i = 0; i < TIERS.length; i += 1) {
      expect(
        Math.abs((observed[i] as number) / rounds - (byTier[i] as number)),
        `tier up to ${TIERS[i]?.upTo}`,
      ).toBeLessThan(0.01);
    }
    expect(Math.abs(missed / rounds - missChance)).toBeLessThan(0.01);
  });

  it('offers between one and four cards a round', () => {
    expect(MAX_CARDS).toBe(4);
  });
});
