/**
 * European (single-zero) roulette.
 *
 * **Fairness draw order.** Exactly one `randBelow(37)`, indexing the physical wheel
 * order - so the drawn index is also where the ball lands, and the animation and the
 * outcome cannot disagree.
 *
 * Every bet on the felt covers some set of numbers, and on a 37-pocket wheel the payout
 * is always `36 / covered - 1` to one. Expressing bets that way means one formula handles
 * straights, splits, corners, dozens and the even-money bets alike, and the 2.70% house
 * edge falls out of the zero being on the wheel but inside no bet's coverage. There is no
 * edge constant anywhere in this file - a test sums the return over all 37 pockets and
 * gets exactly 36/37 for every bet type.
 *
 * Bets arrive as a **type plus a selection**, never as a raw set of numbers. The engine
 * builds the canonical set itself, so a client cannot invent a bet the felt does not
 * have. (Coverage-derived odds make arbitrary sets no *more* profitable, but "the client
 * may describe its own wager" is not a property worth having.)
 */

import type { FairSource } from '@websino/fair';

import { InvalidBetError, payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';

/** Pocket order around a real European wheel. */
export const WHEEL_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

export const POCKETS = WHEEL_ORDER.length;

export const RED_NUMBERS: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const BLACK_NUMBERS: ReadonlySet<number> = new Set(
  Array.from({ length: 36 }, (_, i) => i + 1).filter((n) => !RED_NUMBERS.has(n)),
);

export type Colour = 'green' | 'red' | 'black';

export const colourOf = (n: number): Colour =>
  n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black';

export const pocketIndex = (n: number): number => WHEEL_ORDER.indexOf(n);

export type BetType =
  | 'straight' | 'split' | 'street' | 'corner' | 'sixLine'
  | 'column' | 'dozen' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high';

export interface BetSpec {
  type: BetType;
  /** Meaning depends on the type; empty for the outside bets. */
  selection: number[];
  amount: number;
}

/** `x` in `x:1` for a bet covering `covered` numbers. */
export function payoutOdds(covered: number): number {
  if (covered < 1 || covered > 36 || 36 % covered !== 0) {
    throw new InvalidBetError(`no standard bet covers ${covered} numbers`);
  }
  return 36 / covered - 1;
}

const inRange = (n: number, lo: number, hi: number): boolean =>
  Number.isInteger(n) && n >= lo && n <= hi;

/** Row (0-11) and column (0-2) of a number on the felt. 1-36 sit three across. */
const cellOf = (n: number): [number, number] => [Math.floor((n - 1) / 3), (n - 1) % 3];

/** Two numbers share an edge on the felt, counting the three splits against zero. */
function areAdjacent(a: number, b: number): boolean {
  if (a === b) return false;
  if (a === 0 || b === 0) {
    const other = a === 0 ? b : a;
    return other === 1 || other === 2 || other === 3;
  }
  const [ra, ca] = cellOf(a);
  const [rb, cb] = cellOf(b);
  return (ra === rb && Math.abs(ca - cb) === 1) || (ca === cb && Math.abs(ra - rb) === 1);
}

/** The numbers a bet covers, built from its type - never taken from the client. */
export function numbersFor(spec: BetSpec): number[] {
  const [a, b] = spec.selection;
  const all = (from: number, count: number): number[] =>
    Array.from({ length: count }, (_, i) => from + i);

  switch (spec.type) {
    case 'straight':
      if (!inRange(a ?? -1, 0, 36)) throw new InvalidBetError('straight needs a number 0-36');
      return [a as number];

    case 'split': {
      if (!inRange(a ?? -1, 0, 36) || !inRange(b ?? -1, 0, 36)) {
        throw new InvalidBetError('split needs two numbers');
      }
      if (!areAdjacent(a as number, b as number)) {
        throw new InvalidBetError(`${a} and ${b} do not touch on the layout`);
      }
      return [a as number, b as number].sort((x, y) => x - y);
    }

    case 'street':
      // A street is a row of three, so it starts on 1, 4, 7 ... 34.
      if (!inRange(a ?? -1, 1, 34) || (a as number) % 3 !== 1) {
        throw new InvalidBetError('a street starts at 1, 4, 7 ... 34');
      }
      return all(a as number, 3);

    case 'corner': {
      // The top-left of a 2x2 block: not in the last column, not in the last row.
      if (!inRange(a ?? -1, 1, 32) || (a as number) % 3 === 0) {
        throw new InvalidBetError('that number cannot be the top-left of a corner');
      }
      const n = a as number;
      return [n, n + 1, n + 3, n + 4];
    }

    case 'sixLine':
      if (!inRange(a ?? -1, 1, 31) || (a as number) % 3 !== 1) {
        throw new InvalidBetError('a six line starts at 1, 4, 7 ... 31');
      }
      return all(a as number, 6);

    case 'column':
      if (!inRange(a ?? -1, 0, 2)) throw new InvalidBetError('column must be 0, 1 or 2');
      return all(1, 36).filter((n) => (n - 1) % 3 === a);

    case 'dozen':
      if (!inRange(a ?? -1, 0, 2)) throw new InvalidBetError('dozen must be 0, 1 or 2');
      return all((a as number) * 12 + 1, 12);

    case 'red':   return [...RED_NUMBERS].sort((x, y) => x - y);
    case 'black': return [...BLACK_NUMBERS].sort((x, y) => x - y);
    case 'odd':   return all(1, 36).filter((n) => n % 2 === 1);
    case 'even':  return all(1, 36).filter((n) => n % 2 === 0);
    // `all` takes a count, not an end - high is the eighteen numbers from 19, and
    // writing 36 here made it a 36-number bet paying 0:1.
    case 'low':   return all(1, 18);
    case 'high':  return all(19, 18);

    default:
      throw new InvalidBetError(`unknown bet type: ${String(spec.type)}`);
  }
}

const LABELS: Record<BetType, (s: number[]) => string> = {
  straight: (s) => `Straight ${s[0]}`,
  split: (s) => `Split ${s[0]}/${s[1]}`,
  street: (s) => `Street ${s[0]}-${(s[0] as number) + 2}`,
  corner: (s) => `Corner ${s[0]}`,
  sixLine: (s) => `Six Line ${s[0]}-${(s[0] as number) + 5}`,
  column: (s) => `Column ${(s[0] as number) + 1}`,
  dozen: (s) => `${(s[0] as number) * 12 + 1}-${(s[0] as number) * 12 + 12}`,
  red: () => 'Red',
  black: () => 'Black',
  odd: () => 'Odd',
  even: () => 'Even',
  low: () => '1-18',
  high: () => '19-36',
};

export const labelFor = (spec: BetSpec): string =>
  (LABELS[spec.type] ?? (() => String(spec.type)))(spec.selection);

export interface SettledBet {
  type: BetType;
  selection: number[];
  amount: number;
  label: string;
  numbers: number[];
  odds: number;
  won: boolean;
  payout: number;
}

export interface RouletteConfig {
  bets: BetSpec[];
}

export interface RouletteDetail {
  number: number;
  colour: Colour;
  pocketIndex: number;
  bets: SettledBet[];
  staked: number;
}

/** Maximum bets on the felt at once - a sanity bound on request size, not a rule. */
export const MAX_BETS = 60;

export const roulette: RoundGame<RouletteConfig, RouletteDetail> = {
  id: 'roulette',
  name: 'Roulette',
  // The zero is the entire edge: 1 - 36/37.
  houseEdge: 1 / POCKETS,
  defaultConfig: { bets: [] },

  validateConfig(config) {
    if (!config || !Array.isArray(config.bets) || config.bets.length === 0) {
      throw new InvalidBetError('place at least one bet');
    }
    if (config.bets.length > MAX_BETS) {
      throw new InvalidBetError(`at most ${MAX_BETS} bets at once`);
    }
    for (const spec of config.bets) {
      if (!Number.isInteger(spec.amount) || spec.amount < 1) {
        throw new InvalidBetError('every bet needs a whole-chip amount');
      }
      // Throws if the selection is not a real position on the felt.
      payoutOdds(numbersFor(spec).length);
    }
  },

  play(config, bet, draw: FairSource): RoundOutcome<RouletteDetail> {
    this.validateConfig(config);

    // The stake is the sum of what is on the felt. The caller has already checked the
    // player can afford `bet`, so this is what ties the two together.
    const staked = config.bets.reduce((sum, spec) => sum + spec.amount, 0);
    if (staked !== bet) {
      throw new InvalidBetError(`bets total ${staked} but the stake is ${bet}`);
    }

    const index = draw.randBelow(POCKETS);
    const number = WHEEL_ORDER[index] as number;

    const bets: SettledBet[] = config.bets.map((spec) => {
      const numbers = numbersFor(spec);
      const odds = payoutOdds(numbers.length);
      const won = numbers.includes(number);
      return {
        type: spec.type,
        selection: spec.selection,
        amount: spec.amount,
        label: labelFor(spec),
        numbers,
        odds,
        won,
        // Gross: stake plus winnings. Odds are integers, so nothing rounds here.
        payout: won ? payoutFor(spec.amount, odds + 1) : 0,
      };
    });

    const payout = bets.reduce((sum, b) => sum + b.payout, 0);
    return {
      payout,
      multiplier: bet > 0 ? payout / bet : 0,
      detail: { number, colour: colourOf(number), pocketIndex: index, bets, staked },
    };
  },
};
