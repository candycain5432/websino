import { describe, expect, it } from 'vitest';

import {
  commit,
  createCasualSource,
  FairStream,
  replay,
  verifyCommitment,
} from '../src/index.js';

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

const stream = (clientSeed = 'player', nonce = 0, serverSeed = SEED_A): FairStream =>
  new FairStream({ serverSeed, clientSeed, nonce });

describe('input validation', () => {
  it('rejects a malformed server seed', () => {
    expect(() => stream('p', 0, 'not-hex')).toThrow(/64 hex/);
    expect(() => stream('p', 0, 'a'.repeat(63))).toThrow(/64 hex/);
  });

  it('rejects an empty or oversized client seed', () => {
    expect(() => stream('')).toThrow(/1-256/);
    expect(() => stream('x'.repeat(257))).toThrow(/1-256/);
  });

  it('rejects a non-uint32 nonce', () => {
    expect(() => stream('p', -1)).toThrow(/uint32/);
    expect(() => stream('p', 1.5)).toThrow(/uint32/);
  });
});

describe('determinism', () => {
  it('replays identically from the same three strings', () => {
    const first = stream('me', 7);
    const values = Array.from({ length: 25 }, () => first.nextFloat());
    const again = replay(SEED_A, 'me', 7);
    expect(Array.from({ length: 25 }, () => again.nextFloat())).toEqual(values);
  });

  it('gives different streams for different nonces', () => {
    expect(stream('me', 1).nextFloat()).not.toBe(stream('me', 2).nextFloat());
  });

  it('gives different streams for different client seeds', () => {
    expect(stream('alice').nextFloat()).not.toBe(stream('bob').nextFloat());
  });

  it('gives different streams for different server seeds', () => {
    expect(stream('me', 0, SEED_A).nextFloat()).not.toBe(stream('me', 0, SEED_B).nextFloat());
  });

  it('crosses block boundaries without repeating', () => {
    // One HMAC block is 32 bytes; 40 uint32 draws forces several refills.
    const s = stream();
    const seen = new Set(Array.from({ length: 40 }, () => s.nextUint32()));
    expect(seen.size).toBe(40);
    expect(s.bytesUsed).toBe(160);
  });
});

describe('commitment', () => {
  it('verifies a genuine seed and rejects a tampered one', () => {
    const c = commit(SEED_A);
    expect(verifyCommitment(SEED_A, c)).toBe(true);
    expect(verifyCommitment(SEED_B, c)).toBe(false);
  });

  it('is case-insensitive on the commitment', () => {
    expect(verifyCommitment(SEED_A, commit(SEED_A).toUpperCase())).toBe(true);
  });

  it('exposes a proof carrying the fair version', () => {
    const proof = stream('me', 3).proof();
    expect(proof).toMatchObject({ clientSeed: 'me', nonce: 3, fairVersion: 1 });
    expect(verifyCommitment(proof.serverSeed, proof.commitment)).toBe(true);
  });
});

describe('value derivation', () => {
  it('keeps floats in [0, 1)', () => {
    const s = stream();
    for (let i = 0; i < 5000; i += 1) {
      const f = s.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('keeps uint32 values in range and integral', () => {
    const s = stream();
    for (let i = 0; i < 2000; i += 1) {
      const v = s.nextUint32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 ** 32);
    }
  });

  it('matches the spec formula: nextFloat === nextUint32 / 2**32', () => {
    const a = stream('formula');
    const b = stream('formula');
    for (let i = 0; i < 100; i += 1) {
      expect(a.nextFloat()).toBe(b.nextUint32() / 2 ** 32);
    }
  });

  it('has a mean near 0.5 over many draws', () => {
    const s = stream('mean');
    let total = 0;
    const n = 50_000;
    for (let i = 0; i < n; i += 1) total += s.nextFloat();
    expect(total / n).toBeGreaterThan(0.49);
    expect(total / n).toBeLessThan(0.51);
  });
});

describe('randBelow', () => {
  it('stays in range', () => {
    const s = stream();
    for (const n of [1, 2, 6, 37, 52, 153, 10_000]) {
      for (let i = 0; i < 200; i += 1) {
        const v = s.randBelow(n);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(n);
      }
    }
  });

  it('costs no bytes for n = 1', () => {
    const s = stream();
    expect(s.randBelow(1)).toBe(0);
    expect(s.bytesUsed).toBe(0);
  });

  it('rejects nonsense bounds', () => {
    const s = stream();
    expect(() => s.randBelow(0)).toThrow();
    expect(() => s.randBelow(-5)).toThrow();
    expect(() => s.randBelow(2.5)).toThrow();
  });

  it('is unbiased across a non-power-of-two modulus', () => {
    // 37 (roulette) divides 2**32 unevenly, which is exactly where naive
    // `uint32 % n` develops a measurable bias. Rejection sampling must not.
    const s = stream('bias');
    const counts = new Array<number>(37).fill(0);
    const trials = 185_000; // 5000 expected per pocket
    for (let i = 0; i < trials; i += 1) {
      const pocket = s.randBelow(37);
      counts[pocket] = (counts[pocket] ?? 0) + 1;
    }

    const expected = trials / 37;
    // Chi-square with 36 degrees of freedom: 99.9th percentile is ~67.98.
    const chi = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(67.98);
  });
});

describe('shuffle and sample', () => {
  it('produces a genuine permutation', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const shuffled = stream('deck').shuffle(deck);
    expect(shuffled).toHaveLength(52);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(deck);
  });

  it('does not mutate its input', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const copy = deck.slice();
    stream('deck').shuffle(deck);
    expect(deck).toEqual(copy);
  });

  it('actually reorders', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    expect(stream('deck').shuffle(deck)).not.toEqual(deck);
  });

  it('spreads every card across every position over many shuffles', () => {
    // Guards against a Fisher-Yates off-by-one, the classic version of which
    // leaves index 0 (or the last index) systematically under-mixed.
    const deck = Array.from({ length: 8 }, (_, i) => i);
    const counts = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
    for (let n = 0; n < 16_000; n += 1) {
      const shuffled = stream('spread', n).shuffle(deck);
      shuffled.forEach((card, position) => {
        const row = counts[position] as number[];
        row[card] = (row[card] ?? 0) + 1;
      });
    }
    const expected = 16_000 / 8;
    for (const row of counts) {
      for (const c of row) {
        expect(c).toBeGreaterThan(expected * 0.85);
        expect(c).toBeLessThan(expected * 1.15);
      }
    }
  });

  it('samples k distinct items', () => {
    const picked = stream('mines').sample(
      Array.from({ length: 25 }, (_, i) => i),
      3,
    );
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
  });

  it('refuses an impossible sample size', () => {
    const s = stream();
    expect(() => s.sample([1, 2, 3], 4)).toThrow();
    expect(() => s.sample([1, 2, 3], -1)).toThrow();
  });

  it('picks from a list and refuses an empty one', () => {
    const s = stream();
    expect([10, 20, 30]).toContain(s.pick([10, 20, 30]));
    expect(() => s.pick([])).toThrow();
  });
});

describe('the casual source is not the fair source', () => {
  it('is reproducible from a seed', () => {
    const a = createCasualSource(42);
    const b = createCasualSource(42);
    expect(Array.from({ length: 10 }, () => a.nextFloat())).toEqual(
      Array.from({ length: 10 }, () => b.nextFloat()),
    );
  });

  it('carries a different brand so the two cannot be swapped', () => {
    // The type system enforces this at compile time; assert the runtime tag too,
    // since that is what makes the compile-time brand meaningful.
    expect(createCasualSource(1).kind).toBe('casual');
    expect(stream().kind).toBe('fair');
  });

  it('still behaves like a usable rng', () => {
    const rng = createCasualSource(7);
    const deck = Array.from({ length: 20 }, (_, i) => i);
    expect([...rng.shuffle(deck)].sort((a, b) => a - b)).toEqual(deck);
    expect(rng.randBelow(6)).toBeLessThan(6);
  });
});
