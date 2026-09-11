/**
 * Chips are integers. Always.
 *
 * pysino used floats in places and `round(x, 2)` in others, which is banker's rounding
 * in Python and something else entirely in JavaScript. Keeping every chip amount an
 * integer removes the question: there is no representation error to accumulate and no
 * rounding mode to disagree about.
 *
 * The one place rounding is unavoidable is converting a multiplier into a payout, and
 * that rule is fixed here: **floor, with the fraction going to the house**. Never more
 * than one chip per round, and the tests assert that.
 */

export const MIN_BET = 1;
export const MAX_BET = 100_000;
export const STARTING_CHIPS = 1_000;
export const DAILY_BONUS_CHIPS = 750;
export const BAILOUT_CHIPS = 500;
export const BAILOUT_THRESHOLD = 50;

/** The house's cut on the maths-driven games. RTP = 1 - HOUSE_EDGE. */
export const HOUSE_EDGE = 0.01;

export const CHIP_DENOMINATIONS = [1, 5, 25, 100, 500, 2_500] as const;

export class InvalidBetError extends Error {}

/** Throws unless `bet` is a legal, affordable, integer stake. */
export function assertValidBet(bet: number, balance: number): void {
  if (!Number.isInteger(bet)) throw new InvalidBetError('bet must be a whole number of chips');
  if (bet < MIN_BET) throw new InvalidBetError(`bet must be at least ${MIN_BET}`);
  if (bet > MAX_BET) throw new InvalidBetError(`bet may not exceed ${MAX_BET}`);
  if (bet > balance) throw new InvalidBetError('not enough chips');
}

/**
 * Convert a stake and a multiplier into a whole-chip payout.
 * Floors, so any fraction of a chip stays with the house.
 */
export function payoutFor(bet: number, multiplier: number): number {
  if (multiplier <= 0) return 0;
  return Math.floor(bet * multiplier);
}

/** Break an amount into chip denominations, largest first - for rendering stacks. */
export function chipsForAmount(amount: number): Array<{ denomination: number; count: number }> {
  const out: Array<{ denomination: number; count: number }> = [];
  let remaining = Math.floor(amount);
  for (let i = CHIP_DENOMINATIONS.length - 1; i >= 0; i -= 1) {
    const denomination = CHIP_DENOMINATIONS[i] as number;
    const count = Math.floor(remaining / denomination);
    if (count > 0) {
      out.push({ denomination, count });
      remaining -= count * denomination;
    }
  }
  return out;
}

export const formatChips = (amount: number): string => amount.toLocaleString('en-US');
