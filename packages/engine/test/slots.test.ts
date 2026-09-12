import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import { evaluateGrid, evaluateLine, slots, spinGrid } from '../src/games/slots/index.js';
import {
  buildStrip, CHERRY, CROWN, FREE_SPIN_AWARD, FREE_SPIN_MULTIPLIER, LEMON, LINE_COUNT,
  PAYLINES, PAYTABLE, REEL_STRIPS, REEL_WEIGHTS, REELS, ROWS, SCATTER, SCATTER_PAYS,
  SEVEN, SYMBOL_GLYPHS, SYMBOL_NAMES, SYMBOLS, WILD,
} from '../src/games/slots/reels.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'a'.repeat(64), clientSeed: 'slots', nonce });

/** A grid literal: five symbols per row, three rows. */
const grid = (...rows: string[][]): string[][] => rows;
const row = (...s: string[]): string[] => s;

describe('reel strips', () => {
  it('expands weights to the right length', () => {
    for (let i = 0; i < REEL_STRIPS.length; i += 1) {
      const expected = Object.values(REEL_WEIGHTS[i] as Record<string, number>)
        .reduce((a, b) => a + b, 0);
      expect((REEL_STRIPS[i] as readonly string[]).length).toBe(expected);
    }
  });

  it('honours each symbol s weight exactly', () => {
    for (let i = 0; i < REEL_STRIPS.length; i += 1) {
      const weights = REEL_WEIGHTS[i] as Record<string, number>;
      const counts: Record<string, number> = {};
      for (const s of REEL_STRIPS[i] as readonly string[]) counts[s] = (counts[s] ?? 0) + 1;
      expect(counts).toEqual(weights);
    }
  });

  it('spreads symbols instead of laying them down in blocks', () => {
    // A reel shows three consecutive positions, so a blocked strip would show three of
    // a kind nearly every spin and the entire paytable tuning would be meaningless.
    for (const strip of REEL_STRIPS) {
      for (let i = 0; i < strip.length; i += 1) {
        const a = strip[i] as string;
        const b = strip[(i + 1) % strip.length] as string;
        const c = strip[(i + 2) % strip.length] as string;
        expect(a === b && b === c).toBe(false);
      }
    }
  });

  it('is a pure function of the weights', () => {
    expect(buildStrip({ a: 3, b: 1 })).toEqual(buildStrip({ a: 3, b: 1 }));
  });
});

describe('line evaluation', () => {
  it('pays a run of three from reel one', () => {
    expect(evaluateLine([CHERRY, CHERRY, CHERRY, LEMON, SEVEN])).toEqual({
      symbol: CHERRY, count: 3, units: (PAYTABLE[CHERRY] as readonly number[])[0],
    });
  });

  it('does not pay a run that starts on reel two', () => {
    expect(evaluateLine([LEMON, CHERRY, CHERRY, CHERRY, SEVEN])).toBeNull();
  });

  it('lets wilds substitute', () => {
    expect(evaluateLine([WILD, CHERRY, CHERRY, LEMON, LEMON])).toEqual({
      symbol: CHERRY, count: 3, units: (PAYTABLE[CHERRY] as readonly number[])[0],
    });
  });

  it('pays a leading wild run at whichever reading is worth more', () => {
    // Three wilds then two sevens: five sevens (1500) beats three wilds (125).
    expect(evaluateLine([WILD, WILD, WILD, SEVEN, SEVEN])).toEqual({
      symbol: SEVEN, count: 5, units: (PAYTABLE[SEVEN] as readonly number[])[2],
    });
    // Three wilds then two cherries: three wilds (125) beats five cherries (60).
    expect(evaluateLine([WILD, WILD, WILD, CHERRY, CHERRY])).toEqual({
      symbol: WILD, count: 3, units: (PAYTABLE[WILD] as readonly number[])[0],
    });
  });

  it('never pays scatters on a line', () => {
    expect(evaluateLine([SCATTER, SCATTER, SCATTER, SCATTER, SCATTER])).toBeNull();
  });

  it('stops a run at the first mismatch', () => {
    expect(evaluateLine([CROWN, CROWN, CROWN, CROWN, LEMON])).toEqual({
      symbol: CROWN, count: 4, units: (PAYTABLE[CROWN] as readonly number[])[1],
    });
  });
});

describe('grid evaluation', () => {
  it('pays scatters anywhere and awards free spins', () => {
    const g = grid(
      row(SCATTER, LEMON, CHERRY, LEMON, CHERRY),
      row(CHERRY, SCATTER, LEMON, CHERRY, LEMON),
      row(LEMON, CHERRY, SCATTER, LEMON, CHERRY),
    );
    const spin = evaluateGrid(g, 1, false);
    expect(spin.scatterCount).toBe(3);
    expect(spin.scatterUnits).toBe((SCATTER_PAYS[3] as number) * LINE_COUNT);
    expect(spin.freeSpinsAwarded).toBe(FREE_SPIN_AWARD[3]);
  });

  it('awards nothing for two scatters', () => {
    const g = grid(
      row(SCATTER, LEMON, CHERRY, LEMON, CHERRY),
      row(CHERRY, SCATTER, LEMON, CHERRY, LEMON),
      row(LEMON, CHERRY, CROWN, LEMON, CHERRY),
    );
    const spin = evaluateGrid(g, 1, false);
    expect(spin.scatterUnits).toBe(0);
    expect(spin.freeSpinsAwarded).toBe(0);
  });

  it('applies the free-spin multiplier to the whole spin', () => {
    const g = grid(
      row(CHERRY, CHERRY, CHERRY, LEMON, SEVEN),
      row(LEMON, SEVEN, CROWN, SEVEN, LEMON),
      row(SEVEN, LEMON, SEVEN, CROWN, LEMON),
    );
    const plain = evaluateGrid(g, 1, false);
    const bonus = evaluateGrid(g, FREE_SPIN_MULTIPLIER, true);
    expect(bonus.units).toBe(plain.units * FREE_SPIN_MULTIPLIER);
  });

  it('reports the winning cells so the UI can highlight them', () => {
    const g = grid(
      row(LEMON, LEMON, LEMON, LEMON, LEMON),
      row(CHERRY, CHERRY, CHERRY, SEVEN, SEVEN),
      row(LEMON, LEMON, LEMON, LEMON, LEMON),
    );
    const spin = evaluateGrid(g, 1, false);
    const middle = spin.lineWins.find((w) => w.lineIndex === 0);
    expect(middle?.positions).toEqual([[0, 1], [1, 1], [2, 1]]);
  });
});

describe('spinning', () => {
  it('produces a well-formed grid of real symbols', () => {
    const g = spinGrid(stream(1));
    expect(g).toHaveLength(ROWS);
    for (const r of g) {
      expect(r).toHaveLength(REELS);
      for (const cell of r) expect(SYMBOLS).toContain(cell);
    }
  });

  it('is reproducible from the seed', () => {
    expect(spinGrid(stream(9))).toEqual(spinGrid(stream(9)));
  });

  it('resolves free spins inside the round that triggered them', () => {
    // Scan seeds for a round that actually triggered a bonus, then check the round
    // carries every free spin rather than leaving a counter behind.
    let found = false;
    for (let nonce = 0; nonce < 4000 && !found; nonce += 1) {
      const out = slots.play({}, 1000, stream(nonce));
      if (out.detail.freeSpinsPlayed === 0) continue;
      found = true;
      const free = out.detail.spins.filter((s) => s.isFreeSpin);
      expect(free).toHaveLength(out.detail.freeSpinsPlayed);
      expect(out.detail.spins[0]?.isFreeSpin).toBe(false);
      for (const s of free) expect(s.multiplier).toBe(FREE_SPIN_MULTIPLIER);
    }
    expect(found).toBe(true);
  });

  it('never pays more than the stake allows to rounding', () => {
    for (let nonce = 0; nonce < 300; nonce += 1) {
      const out = slots.play({}, 37, stream(nonce));
      const exact = (37 * out.detail.totalUnits) / LINE_COUNT;
      expect(out.payout).toBe(Math.floor(exact));
      expect(exact - out.payout).toBeLessThan(1);
    }
  });
});

describe('every symbol is presentable', () => {
  it('has a glyph and a name', () => {
    for (const symbol of SYMBOLS) {
      expect(SYMBOL_GLYPHS[symbol]).toBeTruthy();
      expect(SYMBOL_NAMES[symbol]).toBeTruthy();
    }
  });

  it('has a paytable entry for everything that pays on a line', () => {
    for (const symbol of SYMBOLS) {
      if (symbol === SCATTER) continue;
      expect(PAYTABLE[symbol]).toHaveLength(3);
    }
  });

  it('has twenty distinct paylines inside the grid', () => {
    expect(PAYLINES).toHaveLength(LINE_COUNT);
    expect(new Set(PAYLINES.map((p) => p.join(''))).size).toBe(LINE_COUNT);
    for (const pattern of PAYLINES) {
      expect(pattern).toHaveLength(REELS);
      for (const r of pattern) expect(r).toBeGreaterThanOrEqual(0);
      for (const r of pattern) expect(r).toBeLessThan(ROWS);
    }
  });
});

/**
 * The return to player, derived in closed form rather than simulated.
 *
 * This is worth the effort. A slot's RTP is dominated by rare events - the bonus fires
 * about once in 120 rounds and pays double - so a simulation needs millions of rounds
 * before the number stops moving, which is why pysino could only pin it inside a band
 * from 0.88 to 1.02. Two facts make the exact figure computable instead:
 *
 *  - For a fixed payline, the symbol on each reel is uniform over that reel's strip and
 *    independent across reels, because the stop position is uniform. So one line's EV is
 *    a finite sum over 9^5 combinations, and expectation is linear across the 20 lines
 *    even though the lines are correlated.
 *  - Scatters are *not* independent within a reel (three visible rows, one stop), so the
 *    per-reel distribution comes from scanning all stops, then convolving across reels.
 */
describe('return to player, exactly', () => {
  const symbolDistribution = REEL_STRIPS.map((strip) => {
    const counts = new Map<string, number>();
    for (const s of strip) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts.entries()].map(([s, n]) => [s, n / strip.length] as const);
  });

  /** Exact EV of one payline, in line-bet units. */
  const lineEV = ((): number => {
    let ev = 0;
    const walk = (reel: number, symbols: string[], p: number): void => {
      if (reel === REELS) {
        const win = evaluateLine(symbols);
        if (win) ev += p * win.units;
        return;
      }
      for (const [symbol, ps] of symbolDistribution[reel] as ReadonlyArray<readonly [string, number]>) {
        walk(reel + 1, [...symbols, symbol], p * ps);
      }
    };
    walk(0, [], 1);
    return ev;
  })();

  /** Exact distribution of the number of scatters on screen. */
  const scatterDistribution = ((): Map<number, number> => {
    let joint = new Map<number, number>([[0, 1]]);
    for (const strip of REEL_STRIPS) {
      const perReel = [0, 0, 0, 0];
      for (let stop = 0; stop < strip.length; stop += 1) {
        let n = 0;
        for (let o = 0; o < ROWS; o += 1) {
          if (strip[(stop + o) % strip.length] === SCATTER) n += 1;
        }
        perReel[n] = (perReel[n] as number) + 1;
      }
      const next = new Map<number, number>();
      for (const [total, p] of joint) {
        for (let n = 0; n <= ROWS; n += 1) {
          const pn = (perReel[n] as number) / strip.length;
          if (pn === 0) continue;
          next.set(total + n, (next.get(total + n) ?? 0) + p * pn);
        }
      }
      joint = next;
    }
    return joint;
  })();

  let scatterEV = 0;
  let bonusChance = 0;
  let freeSpinsPerSpin = 0;
  for (const [n, p] of scatterDistribution) {
    if (n < 3) continue;
    const capped = Math.min(n, 5);
    scatterEV += p * (SCATTER_PAYS[capped] as number) * LINE_COUNT;
    bonusChance += p;
    freeSpinsPerSpin += p * (FREE_SPIN_AWARD[capped] as number);
  }

  const spinEV = lineEV * LINE_COUNT + scatterEV;
  // Each free spin can retrigger, so the expected number per round is the sum of a
  // geometric series in the per-spin award rate.
  const freeSpinsPerRound = freeSpinsPerSpin / (1 - freeSpinsPerSpin);
  const roundEV = spinEV + freeSpinsPerRound * spinEV * FREE_SPIN_MULTIPLIER;
  const exactRtp = roundEV / LINE_COUNT;

  it('is 94.74%, pinned to four decimal places', () => {
    // Any change to a weight, a paytable entry or the free-spin rules moves this. That
    // is the point: the machine's economics cannot drift without a test saying so.
    expect(exactRtp).toBeCloseTo(0.947374, 6);
  });

  it('leaves the house an edge without gutting the player', () => {
    expect(exactRtp).toBeGreaterThan(0.9);
    expect(exactRtp).toBeLessThan(1);
  });

  it('triggers a bonus about once in 120 rounds', () => {
    expect(1 / bonusChance).toBeGreaterThan(100);
    expect(1 / bonusChance).toBeLessThan(140);
  });

  it('matches a simulation on the low-variance part', () => {
    // The base spin has no rare doubling, so it converges fast and can be checked
    // directly. The bonus contribution is deliberately not asserted by simulation - at
    // 1-in-120 with a fat tail it needs millions of rounds, and the closed form above
    // already covers it.
    const rounds = 60_000;
    let baseUnits = 0;
    for (let nonce = 0; nonce < rounds; nonce += 1) {
      for (const spin of slots.play({}, 100, stream(nonce)).detail.spins) {
        if (!spin.isFreeSpin) baseUnits += spin.units;
      }
    }
    const simulated = baseUnits / rounds / LINE_COUNT;
    expect(simulated).toBeCloseTo(spinEV / LINE_COUNT, 2);
  });

  it('hits something about half the time', () => {
    const rounds = 20_000;
    let hits = 0;
    for (let nonce = 0; nonce < rounds; nonce += 1) {
      if (slots.play({}, 100, stream(nonce)).payout > 0) hits += 1;
    }
    expect(hits / rounds).toBeGreaterThan(0.4);
    expect(hits / rounds).toBeLessThan(0.56);
  });
});
