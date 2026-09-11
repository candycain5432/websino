/**
 * Python's `%` floors toward negative infinity and always returns a value with the
 * sign of the divisor; JavaScript's truncates and keeps the sign of the dividend.
 * `-53 % 8` is 3 in Python and -5 in JS - a difference that silently corrupts any
 * ported bit-shifting or wrap-around arithmetic.
 */
export const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Clamp to an inclusive range. */
export const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;
