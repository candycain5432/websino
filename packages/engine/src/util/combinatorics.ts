/** `math.comb`, which JavaScript lacks. Exact for the sizes this project uses. */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i += 1) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * `C(taken, k) / C(total, k)`, as a running product rather than a quotient of two
 * factorials.
 *
 * This is the probability of drawing `k` items all from the `taken` subset, and it is
 * what mines' multiplier table inverts. Written as `prod (taken - i) / (total - i)` it
 * stays in a sane numeric range for every k, and each factor is a probability in its own
 * right - the chance the *next* pick is safe given the ones before it.
 */
export function chooseRatio(taken: number, total: number, k: number): number {
  if (k < 0 || k > taken || taken > total) return 0;
  let ratio = 1;
  for (let i = 0; i < k; i += 1) ratio *= (taken - i) / (total - i);
  return ratio;
}

/** `itertools.combinations` as a generator. */
export function* combinations<T>(items: readonly T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k > n || k < 0) return;
  const index = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield index.map((i) => items[i] as T);
    let i = k - 1;
    while (i >= 0 && index[i] === i + n - k) i -= 1;
    if (i < 0) return;
    index[i] = (index[i] as number) + 1;
    for (let j = i + 1; j < k; j += 1) index[j] = (index[j - 1] as number) + 1;
  }
}
