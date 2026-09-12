export const formatChips = (n: number): string => Math.trunc(n).toLocaleString('en-US');

export const formatMultiplier = (n: number): string => `${n.toFixed(2)}×`;

/**
 * A multiplier short enough to fit in a plinko bucket.
 *
 * Seventeen buckets across a phone leaves each about 22px, which "40.66×" cannot fit at
 * any readable font size. Two significant figures and no symbol does fit, and the board
 * is unambiguously a board of multipliers without one being stamped on every tile.
 */
export const formatMultiplierShort = (n: number): string => {
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  // Sub-1x drops the leading zero: ".89" rather than "0.89". Three characters instead
  // of four is the difference between fitting a bucket and being ellipsised to "0…".
  return n.toFixed(2).replace(/^0/, '');
};

export const formatDelta = (n: number): string =>
  `${n > 0 ? '+' : ''}${formatChips(n)}`;

/** 4550 hundredths -> "45.50" */
export const formatHundredths = (n: number): string => (n / 100).toFixed(2);
