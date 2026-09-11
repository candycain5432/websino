/**
 * The regression wall.
 *
 * These outputs are frozen. A refactor that changes any of them changes what every
 * player would have won, and silently invalidates every proof issued so far - so a
 * failure here is never "just update the snapshot". It is a `fairVersion` bump, or a bug.
 */

import { describe, expect, it } from 'vitest';

import { commit, FairStream, verifyCommitment } from '../src/index.js';
import vectorFile from './vectors.json' with { type: 'json' };

describe('frozen golden vectors', () => {
  it('is pinned to the fair version the spec documents', () => {
    expect(vectorFile.fairVersion).toBe(1);
  });

  for (const v of vectorFile.vectors) {
    describe(`${v.clientSeed} @ nonce ${v.nonce}`, () => {
      const fresh = (): FairStream =>
        new FairStream({
          serverSeed: v.serverSeed,
          clientSeed: v.clientSeed,
          nonce: v.nonce,
        });

      it('reproduces the committed hash', () => {
        expect(commit(v.serverSeed)).toBe(v.commitment);
        expect(verifyCommitment(v.serverSeed, v.commitment)).toBe(true);
      });

      it('reproduces the float sequence', () => {
        const s = fresh();
        expect(v.floats.map(() => s.nextFloat())).toEqual(v.floats);
      });

      it('reproduces the uint32 sequence', () => {
        const s = fresh();
        expect(v.uint32s.map(() => s.nextUint32())).toEqual(v.uint32s);
      });

      it('reproduces the randBelow(37) sequence', () => {
        const s = fresh();
        expect(v.randBelow37.map(() => s.randBelow(37))).toEqual(v.randBelow37);
      });

      it('reproduces the 52-card shuffle', () => {
        const deck = Array.from({ length: 52 }, (_, i) => i);
        expect(fresh().shuffle(deck)).toEqual(v.shuffled52);
      });

      it('reproduces the 3-of-25 sample', () => {
        const items = Array.from({ length: 25 }, (_, i) => i);
        expect(fresh().sample(items, 3)).toEqual(v.sample25of3);
      });
    });
  }
});
