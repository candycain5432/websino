import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import { HOUSE_EDGE, payoutFor } from '../src/economy/chips.js';
import {
  cashOut, currentMultiplier, currentPayout, isCleared, MAX_MINES, MIN_MINES, MinesError,
  multiplierFor, multiplierTable, nextMultiplier, reveal, safeProbability, safeTiles,
  startMines, TILE_COUNT, type MinesRound,
} from '../src/games/mines/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'd'.repeat(64), clientSeed: 'mines', nonce });

/** Reveal safe tiles until `picks` are down, avoiding the mines. */
function pickSafely(round: MinesRound, picks: number): MinesRound {
  let current = round;
  for (let position = 0; position < TILE_COUNT && current.revealed.length < picks; position += 1) {
    if (current.minePositions.includes(position)) continue;
    current = reveal(current, position);
  }
  return current;
}

describe('the board', () => {
  it('places exactly the requested number of mines', () => {
    for (const mines of [1, 3, 12, 24]) {
      const round = startMines(100, mines, stream(mines));
      expect(round.minePositions).toHaveLength(mines);
      expect(new Set(round.minePositions).size).toBe(mines);
      for (const p of round.minePositions) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(TILE_COUNT);
      }
    }
  });

  it('rejects a mine count off the end of the scale', () => {
    expect(() => startMines(100, MIN_MINES - 1, stream(1))).toThrow(MinesError);
    expect(() => startMines(100, MAX_MINES + 1, stream(1))).toThrow(MinesError);
    expect(() => startMines(100, 2.5, stream(1))).toThrow(MinesError);
  });

  it('rejects a bet that is not a positive whole number', () => {
    expect(() => startMines(0, 3, stream(1))).toThrow(MinesError);
    expect(() => startMines(1.5, 3, stream(1))).toThrow(MinesError);
  });

  it('is reproducible from the seed', () => {
    expect(startMines(100, 5, stream(7)).minePositions)
      .toEqual(startMines(100, 5, stream(7)).minePositions);
  });

  it('consumes the same draws whatever the mine count', () => {
    // The board comes from one shuffle of 25 tiles, so the stream position after a
    // round does not leak how the player configured it.
    const proofs = [1, 12, 24].map((mines) => {
      const s = stream(3);
      startMines(100, mines, s);
      return s.bytesUsed;
    });
    expect(new Set(proofs).size).toBe(1);
  });

  it('spreads mines over the whole grid across many boards', () => {
    const seen = new Set<number>();
    for (let nonce = 0; nonce < 600; nonce += 1) {
      for (const p of startMines(100, 3, stream(nonce)).minePositions) seen.add(p);
    }
    expect(seen.size).toBe(TILE_COUNT);
  });
});

describe('the multiplier ladder', () => {
  it('starts at 1.00x with nothing revealed', () => {
    expect(multiplierFor(3, 0)).toBe(1);
  });

  it('climbs with every pick', () => {
    const table = multiplierTable(3);
    for (let i = 1; i < table.length; i += 1) {
      expect(table[i] as number).toBeGreaterThan(table[i - 1] as number);
    }
  });

  it('climbs faster with more mines', () => {
    expect(multiplierFor(10, 1)).toBeGreaterThan(multiplierFor(3, 1));
    expect(multiplierFor(24, 1)).toBeGreaterThan(multiplierFor(10, 1));
  });

  it('covers exactly the safe tiles', () => {
    for (const mines of [1, 5, 24]) {
      expect(multiplierTable(mines)).toHaveLength(safeTiles(mines));
    }
  });

  it('refuses to price more picks than there are safe tiles', () => {
    expect(() => multiplierFor(24, 2)).toThrow(MinesError);
  });

  it('pays 24.75x for the single-safe-tile board', () => {
    // 24 mines leaves one safe tile: a 1-in-25 shot, so 0.99 * 25.
    expect(multiplierFor(24, 1)).toBeCloseTo(24.75, 10);
  });
});

/**
 * The identity the whole game rests on, and the reason it is interesting: because the
 * multiplier is the exact inverse of the probability of getting that far, **every**
 * cash-out depth is worth the same 0.99. Playing one tile and clearing the board have
 * identical expected value; only the variance differs.
 *
 * Asserted exactly, for every mine count and every depth - not sampled.
 */
describe('every cash-out point is worth exactly 0.99', () => {
  for (const mines of [1, 2, 3, 5, 8, 12, 18, 24]) {
    it(`${mines} mines`, () => {
      for (let picks = 1; picks <= safeTiles(mines); picks += 1) {
        const ev = safeProbability(mines, picks) * multiplierFor(mines, picks);
        expect(ev).toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    });
  }

  it('holds for the probability of the very first pick', () => {
    for (let mines = MIN_MINES; mines <= MAX_MINES; mines += 1) {
      expect(safeProbability(mines, 1)).toBeCloseTo((TILE_COUNT - mines) / TILE_COUNT, 12);
    }
  });

  it('gives a zero probability past the safe tiles', () => {
    expect(safeProbability(24, 2)).toBe(0);
  });
});

describe('playing a board', () => {
  it('pays back the stake before anything is revealed', () => {
    expect(currentPayout(startMines(100, 3, stream(1)))).toBe(100);
  });

  it('busts on a mine and pays nothing', () => {
    const round = startMines(100, 3, stream(2));
    const bust = reveal(round, round.minePositions[0] as number);
    expect(bust.state).toBe('busted');
    expect(bust.hitPosition).toBe(round.minePositions[0]);
    expect(currentPayout(bust)).toBe(0);
  });

  it('climbs the ladder as tiles come up safe', () => {
    const round = pickSafely(startMines(100, 3, stream(3)), 4);
    expect(round.revealed).toHaveLength(4);
    expect(round.state).toBe('playing');
    expect(currentMultiplier(round)).toBeCloseTo(multiplierFor(3, 4), 10);
    expect(currentPayout(round)).toBe(payoutFor(100, multiplierFor(3, 4)));
  });

  it('refuses a tile twice, or a tile off the board', () => {
    const round = pickSafely(startMines(100, 3, stream(4)), 1);
    expect(() => reveal(round, round.revealed[0] as number)).toThrow(/already revealed/);
    expect(() => reveal(round, -1)).toThrow(/off the board/);
    expect(() => reveal(round, TILE_COUNT)).toThrow(/off the board/);
  });

  it('cashes out automatically when the board is cleared', () => {
    const round = pickSafely(startMines(100, 24, stream(5)), 1);
    expect(isCleared(round)).toBe(true);
    expect(round.state).toBe('cashed');
    expect(currentPayout(round)).toBe(payoutFor(100, 24.75));
  });

  it('refuses to cash out before anything is revealed', () => {
    expect(() => cashOut(startMines(100, 3, stream(6)))).toThrow(/at least one tile/);
  });

  it('refuses to act on a finished board', () => {
    const round = startMines(100, 3, stream(7));
    const bust = reveal(round, round.minePositions[0] as number);
    expect(() => reveal(bust, 0)).toThrow(/no board in play/);
    expect(() => cashOut(bust)).toThrow(/nothing to cash out/);
  });

  it('reports the next rung so the player can see what one more tile is worth', () => {
    const round = pickSafely(startMines(100, 3, stream(8)), 2);
    expect(nextMultiplier(round)).toBeCloseTo(multiplierFor(3, 3), 10);
  });

  it('has no next rung once the board is clear', () => {
    expect(nextMultiplier(pickSafely(startMines(100, 24, stream(9)), 1))).toBeNull();
  });
});

describe('the house edge in practice', () => {
  it('returns ~99% at every cash-out depth, over many boards', () => {
    // The identity above is exact; this checks the *engine* agrees with it, by playing
    // real boards against real seeds rather than by evaluating the formula again.
    for (const [mines, depth] of [[3, 3], [5, 2], [10, 1]] as const) {
      const rounds = 20_000;
      let staked = 0;
      let returned = 0;

      for (let nonce = 0; nonce < rounds; nonce += 1) {
        let round = startMines(100, mines, stream(nonce));
        staked += 100;
        // Pick a fixed set of tiles every time, so the strategy cannot adapt.
        for (let position = 0; position < depth; position += 1) {
          round = reveal(round, position);
          if (round.state === 'busted') break;
        }
        if (round.state === 'playing') round = cashOut(round);
        returned += currentPayout(round);
      }

      const rtp = returned / staked;
      expect(Math.abs(rtp - (1 - HOUSE_EDGE))).toBeLessThan(0.03);
    }
  });

  it('conserves chips: a payout never exceeds the top of the ladder', () => {
    for (let nonce = 0; nonce < 2000; nonce += 1) {
      const mines = (nonce % MAX_MINES) + 1;
      const round = pickSafely(startMines(100, mines, stream(nonce)), 3);
      const top = multiplierFor(mines, safeTiles(mines));
      expect(currentPayout(round)).toBeLessThanOrEqual(payoutFor(100, top));
      expect(Number.isInteger(currentPayout(round))).toBe(true);
    }
  });
});
