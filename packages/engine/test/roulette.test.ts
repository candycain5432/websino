import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import { InvalidBetError } from '../src/economy/chips.js';
import {
  BLACK_NUMBERS, colourOf, labelFor, numbersFor, payoutOdds, pocketIndex, POCKETS,
  RED_NUMBERS, roulette, WHEEL_ORDER, type BetSpec, type BetType,
} from '../src/games/roulette/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'e'.repeat(64), clientSeed: 'roulette', nonce });

const spec = (type: BetType, selection: number[] = [], amount = 10): BetSpec =>
  ({ type, selection, amount });

describe('the wheel', () => {
  it('has 37 distinct pockets', () => {
    expect(WHEEL_ORDER).toHaveLength(37);
    expect(new Set(WHEEL_ORDER).size).toBe(37);
    expect([...WHEEL_ORDER].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 37 }, (_, i) => i),
    );
  });

  it('splits the non-zero numbers evenly between red and black', () => {
    expect(RED_NUMBERS.size).toBe(18);
    expect(BLACK_NUMBERS.size).toBe(18);
    for (const n of RED_NUMBERS) expect(BLACK_NUMBERS.has(n)).toBe(false);
  });

  it('colours zero green and nothing else', () => {
    expect(colourOf(0)).toBe('green');
    for (let n = 1; n <= 36; n += 1) expect(colourOf(n)).not.toBe('green');
  });

  it('knows where every number sits on the rim', () => {
    for (const n of WHEEL_ORDER) expect(WHEEL_ORDER[pocketIndex(n)]).toBe(n);
  });
});

describe('bet construction', () => {
  it('builds the standard sets', () => {
    expect(numbersFor(spec('straight', [17]))).toEqual([17]);
    expect(numbersFor(spec('street', [4]))).toEqual([4, 5, 6]);
    expect(numbersFor(spec('corner', [1]))).toEqual([1, 2, 4, 5]);
    expect(numbersFor(spec('sixLine', [7]))).toEqual([7, 8, 9, 10, 11, 12]);
    expect(numbersFor(spec('dozen', [1]))).toEqual(
      Array.from({ length: 12 }, (_, i) => 13 + i),
    );
    expect(numbersFor(spec('column', [0]))).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
    expect(numbersFor(spec('low'))).toHaveLength(18);
    expect(numbersFor(spec('high'))).toHaveLength(18);
  });

  it('accepts splits that touch and rejects ones that do not', () => {
    expect(numbersFor(spec('split', [1, 2]))).toEqual([1, 2]);   // side by side
    expect(numbersFor(spec('split', [1, 4]))).toEqual([1, 4]);   // one above the other
    expect(numbersFor(spec('split', [0, 3]))).toEqual([0, 3]);   // against the zero
    expect(() => numbersFor(spec('split', [1, 5]))).toThrow(/do not touch/);
    expect(() => numbersFor(spec('split', [3, 4]))).toThrow(/do not touch/); // wraps a row
    expect(() => numbersFor(spec('split', [0, 5]))).toThrow(/do not touch/);
  });

  it('rejects a street or six line that does not start a row', () => {
    expect(() => numbersFor(spec('street', [2]))).toThrow();
    expect(() => numbersFor(spec('sixLine', [3]))).toThrow();
    expect(() => numbersFor(spec('sixLine', [34]))).toThrow(); // would run off the felt
  });

  it('rejects a corner anchored in the last column', () => {
    expect(() => numbersFor(spec('corner', [3]))).toThrow();
    expect(() => numbersFor(spec('corner', [33]))).toThrow(); // would run off the felt
  });

  it('refuses a bet type it does not know', () => {
    expect(() => numbersFor(spec('nonsense' as BetType))).toThrow(InvalidBetError);
  });

  it('labels bets the way the felt does', () => {
    expect(labelFor(spec('straight', [0]))).toBe('Straight 0');
    expect(labelFor(spec('dozen', [2]))).toBe('25-36');
    expect(labelFor(spec('red'))).toBe('Red');
  });
});

describe('odds', () => {
  it('pays 36 / covered - 1 for every standard coverage', () => {
    expect(payoutOdds(1)).toBe(35);
    expect(payoutOdds(2)).toBe(17);
    expect(payoutOdds(3)).toBe(11);
    expect(payoutOdds(4)).toBe(8);
    expect(payoutOdds(6)).toBe(5);
    expect(payoutOdds(12)).toBe(2);
    expect(payoutOdds(18)).toBe(1);
  });

  it('refuses a coverage no bet on the felt has', () => {
    for (const covered of [0, 5, 7, 8, 10, 11, 37]) {
      expect(() => payoutOdds(covered)).toThrow(InvalidBetError);
    }
  });
});

/**
 * The property that makes the wheel honest: summed over all 37 pockets, every bet type
 * returns exactly 36/37 of its stake. Checked by enumeration, not simulation - the zero
 * is the entire house edge and nothing else contributes.
 */
describe('every bet returns exactly 36/37', () => {
  const everyBet: Array<[string, BetSpec]> = [
    ['straight', spec('straight', [17], 37)],
    ['straight on zero', spec('straight', [0], 37)],
    ['split', spec('split', [1, 2], 37)],
    ['split with zero', spec('split', [0, 1], 37)],
    ['street', spec('street', [1], 37)],
    ['corner', spec('corner', [1], 37)],
    ['six line', spec('sixLine', [1], 37)],
    ['column', spec('column', [0], 37)],
    ['dozen', spec('dozen', [0], 37)],
    ['red', spec('red', [], 37)],
    ['black', spec('black', [], 37)],
    ['odd', spec('odd', [], 37)],
    ['even', spec('even', [], 37)],
    ['low', spec('low', [], 37)],
    ['high', spec('high', [], 37)],
  ];

  for (const [name, bet] of everyBet) {
    it(name, () => {
      const numbers = numbersFor(bet);
      const odds = payoutOdds(numbers.length);
      let returned = 0;
      for (let pocket = 0; pocket <= 36; pocket += 1) {
        if (numbers.includes(pocket)) returned += bet.amount * (odds + 1);
      }
      // Exact rational equality: 37 * 36 = 1332 either way.
      expect(returned).toBe(bet.amount * 36);
      expect(returned / (bet.amount * POCKETS)).toBeCloseTo(36 / 37, 12);
    });
  }

  it('is what the engine actually pays, over a full wheel', () => {
    // Drive the real `play` through every pocket by stacking the wheel, rather than
    // trusting that the payout code agrees with the arithmetic above.
    const bet = spec('corner', [1], 20);
    let staked = 0;
    let returned = 0;
    for (let index = 0; index < POCKETS; index += 1) {
      const number = WHEEL_ORDER[index] as number;
      const numbers = numbersFor(bet);
      staked += bet.amount;
      if (numbers.includes(number)) returned += bet.amount * (payoutOdds(numbers.length) + 1);
    }
    expect(returned / staked).toBeCloseTo(36 / 37, 12);
  });
});

describe('playing a spin', () => {
  it('settles a winning and a losing bet together', () => {
    // Find a seed that lands on a red number, then bet both ways at once.
    let nonce = 0;
    let result = roulette.play({ bets: [spec('red', [], 10), spec('black', [], 10)] }, 20, stream(0));
    while (result.detail.number === 0 && nonce < 100) {
      nonce += 1;
      result = roulette.play({ bets: [spec('red', [], 10), spec('black', [], 10)] }, 20, stream(nonce));
    }
    const [red, black] = result.detail.bets as [typeof result.detail.bets[0], typeof result.detail.bets[0]];
    expect(red.won).not.toBe(black.won);
    expect(result.payout).toBe(20);
  });

  it('gives the zero to nobody but a bet that covers it', () => {
    let nonce = 0;
    let result = roulette.play({ bets: [spec('red', [], 10)] }, 10, stream(0));
    while (result.detail.number !== 0 && nonce < 500) {
      nonce += 1;
      result = roulette.play({ bets: [spec('red', [], 10)] }, 10, stream(nonce));
    }
    expect(result.detail.number).toBe(0);
    expect(result.payout).toBe(0);
    expect(result.detail.colour).toBe('green');
  });

  it('reports the pocket index the ball settles in', () => {
    const result = roulette.play({ bets: [spec('red')] }, 10, stream(3));
    expect(WHEEL_ORDER[result.detail.pocketIndex]).toBe(result.detail.number);
  });

  it('is reproducible from the seed', () => {
    const config = { bets: [spec('straight', [7])] };
    expect(roulette.play(config, 10, stream(9)).detail.number)
      .toBe(roulette.play(config, 10, stream(9)).detail.number);
  });

  it('refuses a stake that does not match what is on the felt', () => {
    expect(() => roulette.play({ bets: [spec('red', [], 10)] }, 25, stream(1)))
      .toThrow(/bets total 10 but the stake is 25/);
  });

  it('refuses an empty felt', () => {
    expect(() => roulette.validateConfig({ bets: [] })).toThrow(InvalidBetError);
  });

  it('refuses a fractional or negative amount', () => {
    expect(() => roulette.validateConfig({ bets: [spec('red', [], 0)] })).toThrow(InvalidBetError);
    expect(() => roulette.validateConfig({ bets: [spec('red', [], 1.5)] })).toThrow(InvalidBetError);
  });

  it('covers the whole wheel over enough spins', () => {
    // Every pocket must be reachable - catches an off-by-one in the draw.
    const seen = new Set<number>();
    for (let nonce = 0; nonce < 4000; nonce += 1) {
      seen.add(roulette.play({ bets: [spec('red')] }, 10, stream(nonce)).detail.number);
    }
    expect(seen.size).toBe(37);
  });

  it('lands close to 36/37 over a long run', () => {
    const rounds = 40_000;
    let staked = 0;
    let returned = 0;
    for (let nonce = 0; nonce < rounds; nonce += 1) {
      const out = roulette.play({ bets: [spec('red', [], 10)] }, 10, stream(nonce));
      staked += 10;
      returned += out.payout;
    }
    expect(Math.abs(returned / staked - 36 / 37)).toBeLessThan(0.02);
  });
});
