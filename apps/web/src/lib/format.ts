export const formatChips = (n: number): string => Math.trunc(n).toLocaleString('en-US');

export const formatMultiplier = (n: number): string => `${n.toFixed(2)}×`;

export const formatDelta = (n: number): string =>
  `${n > 0 ? '+' : ''}${formatChips(n)}`;

/** 4550 hundredths -> "45.50" */
export const formatHundredths = (n: number): string => (n / 100).toFixed(2);
