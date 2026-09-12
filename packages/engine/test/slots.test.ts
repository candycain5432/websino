import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import {
  buildStrip, evaluateGrid, evaluateLine, exactReturn, lineCountOf, machineById,
  slots, spinGrid, stripsOf, GOLDEN_REELS, MACHINES, REELS, ROWS, SCATTER, WILD,
} from '../src/games/slots/index.js';

/**
 * The classic cabinet, under test throughout unless a case says otherwise.
 *
 * Everything that used to be a module-level constant is now a property of a machine,
 * which is the whole point of the variety pack - but the classic's numbers are
 * unchanged, and the pinned return below proves it.
 */
const M = GOLDEN_REELS;
const REEL_STRIPS = stripsOf(M);
const REEL_WEIGHTS = M.reelWeights;
const PAYTABLE = M.paytable;
const PAYLINES = M.paylines;
const LINE_COUNT = lineCountOf(M);
const SYMBOLS = M.symbols;
const SYMBOL_GLYPHS = M.glyphs;
const SYMBOL_NAMES = M.names;
const SCATTER_PAYS = M.scatterPays;
const FREE_SPIN_AWARD = M.freeSpinAward;
const FREE_SPIN_MULTIPLIER = M.freeSpinMultiplier;
const CHERRY = 'cherry';
const LEMON = 'lemon';
const CROWN = 'crown';
const SEVEN = 'seven';

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
    expect(evaluateLine(M, [CHERRY, CHERRY, CHERRY, LEMON, SEVEN])).toEqual({
      symbol: CHERRY, count: 3, units: (PAYTABLE[CHERRY] as readonly number[])[0],
    });
  });

  it('does not pay a run that starts on reel two', () => {
    expect(evaluateLine(M, [LEMON, CHERRY, CHERRY, CHERRY, SEVEN])).toBeNull();
  });

  it('lets wilds substitute', () => {
    expect(evaluateLine(M, [WILD, CHERRY, CHERRY, LEMON, LEMON])).toEqual({
      symbol: CHERRY, count: 3, units: (PAYTABLE[CHERRY] as readonly number[])[0],
    });
  });

  it('pays a leading wild run at whichever reading is worth more', () => {
    // Three wilds then two sevens: five sevens (1500) beats three wilds (125).
    expect(evaluateLine(M, [WILD, WILD, WILD, SEVEN, SEVEN])).toEqual({
      symbol: SEVEN, count: 5, units: (PAYTABLE[SEVEN] as readonly number[])[2],
    });
    // Three wilds then two cherries: three wilds (125) beats five cherries (60).
    expect(evaluateLine(M, [WILD, WILD, WILD, CHERRY, CHERRY])).toEqual({
      symbol: WILD, count: 3, units: (PAYTABLE[WILD] as readonly number[])[0],
    });
  });

  it('never pays scatters on a line', () => {
    expect(evaluateLine(M, [SCATTER, SCATTER, SCATTER, SCATTER, SCATTER])).toBeNull();
  });

  it('stops a run at the first mismatch', () => {
    expect(evaluateLine(M, [CROWN, CROWN, CROWN, CROWN, LEMON])).toEqual({
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
    const spin = evaluateGrid(M, g, 1, false);
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
    const spin = evaluateGrid(M, g, 1, false);
    expect(spin.scatterUnits).toBe(0);
    expect(spin.freeSpinsAwarded).toBe(0);
  });

  it('applies the free-spin multiplier to the whole spin', () => {
    const g = grid(
      row(CHERRY, CHERRY, CHERRY, LEMON, SEVEN),
      row(LEMON, SEVEN, CROWN, SEVEN, LEMON),
      row(SEVEN, LEMON, SEVEN, CROWN, LEMON),
    );
    const plain = evaluateGrid(M, g, 1, false);
    const bonus = evaluateGrid(M, g, FREE_SPIN_MULTIPLIER, true);
    expect(bonus.units).toBe(plain.units * FREE_SPIN_MULTIPLIER);
  });

  it('reports the winning cells so the UI can highlight them', () => {
    const g = grid(
      row(LEMON, LEMON, LEMON, LEMON, LEMON),
      row(CHERRY, CHERRY, CHERRY, SEVEN, SEVEN),
      row(LEMON, LEMON, LEMON, LEMON, LEMON),
    );
    const spin = evaluateGrid(M, g, 1, false);
    const middle = spin.lineWins.find((w) => w.lineIndex === 0);
    expect(middle?.positions).toEqual([[0, 1], [1, 1], [2, 1]]);
  });
});

describe('spinning', () => {
  it('produces a well-formed grid of real symbols', () => {
    const g = spinGrid(M, stream(1));
    expect(g).toHaveLength(ROWS);
    for (const r of g) {
      expect(r).toHaveLength(REELS);
      for (const cell of r) expect(SYMBOLS).toContain(cell);
    }
  });

  it('is reproducible from the seed', () => {
    expect(spinGrid(M, stream(9))).toEqual(spinGrid(M, stream(9)));
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
  // The derivation moved into the engine so every cabinet has one; this is the same
  // arithmetic, now a property of the machine rather than of this file.
  const { rtp: exactRtp, bonusChance, spinUnits: spinEV } = exactReturn(M);

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

// ------------------------------------------------------------- the variety pack --

/**
 * Every cabinet, held to the same standard as the classic.
 *
 * The point of making a machine into data is that a new one cannot smuggle in a broken
 * economy: its return is computable, so it gets pinned exactly, and the structural rules
 * that made the original work are checked for all of them rather than assumed.
 */
describe('the variety pack', () => {
  it('has exactly these returns, pinned to four decimals', () => {
    const actual: Record<string, string> = {};
    for (const m of MACHINES) actual[m.id] = (exactReturn(m).rtp * 100).toFixed(4);
    expect(actual).toEqual({
      golden: '94.7374',
      neon: '95.5178',
      emerald: '94.8219',
    });
  });

  it('keeps every cabinet within a point of the others', () => {
    // The cabinets are meant to differ in *volatility*, not in how much they return.
    // Plain rounding of a scaled paytable put them 1.5 points apart with the swingy one
    // paying least, which is backwards; this is the assertion that caught it.
    const rtps = MACHINES.map((m) => exactReturn(m).rtp);
    expect(Math.max(...rtps) - Math.min(...rtps)).toBeLessThan(0.01);
    for (const rtp of rtps) {
      expect(rtp).toBeGreaterThan(0.93);
      expect(rtp).toBeLessThan(0.97);
    }
  });

  it('differs in volatility, which is the whole point', () => {
    const neon = machineById('neon');
    const emerald = machineById('emerald');
    // Fewer lines and a steeper top end on one; more lines and a flatter table on the
    // other. If these ever converge the pack is three copies of one machine.
    expect(lineCountOf(neon)).toBeLessThan(lineCountOf(GOLDEN_REELS));
    expect(lineCountOf(emerald)).toBeGreaterThan(lineCountOf(GOLDEN_REELS));
    expect(exactReturn(neon).topLine).toBeGreaterThan(exactReturn(emerald).topLine * 5);
    // The flat cabinet buys its bonus more often.
    expect(exactReturn(emerald).bonusChance).toBeGreaterThan(exactReturn(neon).bonusChance);
  });

  it('gives every cabinet a well-formed paytable and lines', () => {
    for (const m of MACHINES) {
      for (const symbol of m.symbols) {
        expect(m.glyphs[symbol], `${m.id} ${symbol} glyph`).toBeTruthy();
        expect(m.names[symbol], `${m.id} ${symbol} name`).toBeTruthy();
        if (symbol !== SCATTER) expect(m.paytable[symbol], `${m.id} ${symbol}`).toHaveLength(3);
      }
      // Nothing pays that is not a symbol on this cabinet.
      for (const symbol of Object.keys(m.paytable)) expect(m.symbols).toContain(symbol);

      expect(m.paylines.length).toBeGreaterThan(0);
      expect(new Set(m.paylines.map((p) => p.join(''))).size).toBe(m.paylines.length);
      for (const pattern of m.paylines) {
        expect(pattern).toHaveLength(REELS);
        for (const r of pattern) {
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThan(ROWS);
        }
      }

      // Five reels, and a strip that never shows three of a kind from one stop.
      const strips = stripsOf(m);
      expect(strips).toHaveLength(REELS);
      for (const strip of strips) {
        for (let i = 0; i < strip.length; i += 1) {
          const a = strip[i] as string;
          const b = strip[(i + 1) % strip.length] as string;
          const c = strip[(i + 2) % strip.length] as string;
          expect(a === b && b === c, `${m.id} blocked strip at ${i}`).toBe(false);
        }
      }
    }
  });

  it('pays more per line the more of a symbol lands, on every cabinet', () => {
    for (const m of MACHINES) {
      for (const [symbol, pays] of Object.entries(m.paytable)) {
        expect(pays[1], `${m.id} ${symbol} 4-of-a-kind`).toBeGreaterThan(pays[0]);
        expect(pays[2], `${m.id} ${symbol} 5-of-a-kind`).toBeGreaterThan(pays[1]);
      }
      // And the wild is the best symbol on the cabinet, as the rarest should be.
      const wildTop = (m.paytable[WILD] as readonly number[])[2] as number;
      for (const [symbol, pays] of Object.entries(m.paytable)) {
        if (symbol === WILD) continue;
        expect(wildTop, `${m.id} wild vs ${symbol}`).toBeGreaterThan(pays[2]);
      }
    }
  });

  it('plays every cabinet from the round API', () => {
    for (const m of MACHINES) {
      const result = slots.play({ machine: m.id }, 100, stream(7));
      expect(result.detail.machine).toBe(m.id);
      expect(result.detail.lineCount).toBe(lineCountOf(m));
      expect(result.detail.spins[0]?.grid).toHaveLength(ROWS);
      // Only this cabinet's symbols may appear on it.
      for (const spin of result.detail.spins) {
        for (const row of spin.grid) for (const cell of row) expect(m.symbols).toContain(cell);
      }
      expect(result.payout).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults to the classic and refuses a cabinet that does not exist', () => {
    expect(slots.play({}, 100, stream(3)).detail.machine).toBe('golden');
    expect(() => slots.validateConfig({ machine: 'jackpot-city' })).toThrow(/unknown slot machine/);
    expect(() => machineById('nope')).toThrow(/unknown slot machine/);
  });

  it('draws five stops per spin whatever the cabinet', () => {
    for (const m of MACHINES) {
      const source = stream(21);
      const before = source.bytesUsed;
      spinGrid(m, source);
      expect(source.bytesUsed - before, m.id).toBe(REELS * 4);
    }
  });
});
