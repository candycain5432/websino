/**
 * Hi-Lo and Towers.
 *
 * Both are "keep going or take the money" games, and both price each step as
 * `(1 - edge) / chance`. That makes every cash-out point carry identical expected value,
 * which is the invariant worth asserting - and it is asserted exactly, by enumerating
 * the outcome space rather than by sampling it.
 */

import { FairStream } from '@websino/fair';
import { describe, expect, it } from 'vitest';

import { DECK_SIZE, makeCard, RANKS, rankOf, type Card } from '../src/cards.js';
import { HOUSE_EDGE } from '../src/economy/chips.js';
import {
  startHiLo, guess, cashOut as hiloCashOut, currentPayout as hiloPayout, currentCard,
  guessWins, stepMultiplier, winChance, winningRanks, HiLoError, MAX_STEPS,
  type HiLoGuess,
} from '../src/games/hilo/index.js';
import {
  startTowers, climb, cashOut as towersCashOut, currentPayout as towersPayout,
  multiplierFor, multiplierTable, rowChance, tilesPerRow, trapsPerRow,
  DIFFICULTIES, ROWS, TowersError, type Difficulty,
} from '../src/games/towers/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'd4'.repeat(32), clientSeed: 'ladders', nonce });

const GUESSES: HiLoGuess[] = ['higher', 'lower'];
const LEVELS = Object.keys(DIFFICULTIES) as Difficulty[];

// ------------------------------------------------------------------------ hi-lo --

describe('hi-lo odds', () => {
  it('counts the ranks that win, not the cards', () => {
    // A two is the bottom rank: higher-or-same covers all thirteen.
    expect(winningRanks(makeCard(0, 0), 'higher')).toBe(13);
    expect(winningRanks(makeCard(0, 0), 'lower')).toBe(1);
    // An ace is the top: lower-or-same covers all thirteen.
    expect(winningRanks(makeCard(12, 0), 'higher')).toBe(1);
    expect(winningRanks(makeCard(12, 0), 'lower')).toBe(13);
    // And the suit never matters.
    for (let suit = 0; suit < 4; suit += 1) {
      expect(winningRanks(makeCard(6, suit), 'higher')).toBe(7);
    }
  });

  it('overlaps on equality rather than leaving a gap', () => {
    // The two choices covering 14 ranks between 13 is the point: a pair pays either
    // way. Chances summing to more than one is what that looks like in arithmetic.
    for (let rank = 0; rank < RANKS; rank += 1) {
      const card = makeCard(rank, 0);
      expect(winningRanks(card, 'higher') + winningRanks(card, 'lower')).toBe(RANKS + 1);
    }
  });

  it('prices every step at exactly (1 - edge) / chance', () => {
    for (let rank = 0; rank < RANKS; rank += 1) {
      for (const choice of GUESSES) {
        const card = makeCard(rank, 1);
        expect(stepMultiplier(card, choice) * winChance(card, choice))
          .toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    }
  });

  /**
   * The expected value of one step, enumerated over all 52 possible next cards.
   *
   * This is the assertion the whole pricing scheme rests on, and it is exact - there is
   * no sampling here, just every outcome weighted by its probability.
   */
  it('returns 99% on a single step, whatever the card and whichever way you guess', () => {
    for (let rank = 0; rank < RANKS; rank += 1) {
      for (const choice of GUESSES) {
        const card = makeCard(rank, 0);
        let won = 0;
        for (let next = 0; next < DECK_SIZE; next += 1) {
          if (guessWins(card, next as Card, choice)) won += 1;
        }
        const ev = (won / DECK_SIZE) * stepMultiplier(card, choice);
        expect(ev, `rank ${rank} ${choice}`).toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    }
  });

  it('pays a guaranteed guess less than the stake, because the edge still applies', () => {
    // Higher-or-same against a two cannot lose - and pays 0.99x. Worth stating out
    // loud: the free step is not free, and a player can see that before taking it.
    const two = makeCard(0, 0);
    expect(winChance(two, 'higher')).toBe(1);
    expect(stepMultiplier(two, 'higher')).toBeCloseTo(0.99, 12);
  });
});

describe('playing hi-lo', () => {
  it('lays the whole run at the start, so play never touches the stream', () => {
    // Same reasoning as the tower: how far a player gets must not shift where the
    // stream ends up, or their own choices move the next round's cards.
    const source = stream(1);
    let round = startHiLo(100, source);
    const afterStart = source.bytesUsed;
    expect(round.cards).toHaveLength(MAX_STEPS + 1);

    round = guess(round, 'higher');
    expect(source.bytesUsed).toBe(afterStart);
    expect(round.history).toHaveLength(1);
  });

  it('compounds the multiplier over a winning streak', () => {
    /*
     * Find a seed that actually produces a streak rather than hoping for one.
     *
     * The first version played one fixed seed and happened to bust on its opening
     * guess, so it asserted nothing about compounding at all. Scanning is still fully
     * deterministic - the same seed is chosen on every run - and it guarantees the
     * assertion below has something to bite on.
     */
    const play = (nonce: number) => {
      let round = startHiLo(100, stream(nonce));
      let expected = 1;
      let steps = 0;
      const errors: number[] = [];
      while (round.state === 'playing' && steps < 5) {
        const choice: HiLoGuess = rankOf(currentCard(round)) <= 6 ? 'higher' : 'lower';
        const step = stepMultiplier(currentCard(round), choice);
        round = guess(round, choice);
        if (round.state === 'busted') break;
        expected *= step;
        steps += 1;
        errors.push(Math.abs(round.multiplier - expected));
      }
      return { steps, worst: Math.max(0, ...errors) };
    };

    let found = { steps: 0, worst: 0 };
    for (let nonce = 0; nonce < 200 && found.steps < 3; nonce += 1) found = play(nonce);

    expect(found.steps).toBeGreaterThanOrEqual(3);
    // Every intermediate multiplier matched the running product of its own steps.
    expect(found.worst).toBeLessThan(1e-10);
  });

  it('pays the stake back untouched before any guess is made', () => {
    const round = startHiLo(250, stream(3));
    expect(hiloPayout(round)).toBe(250);
    expect(() => hiloCashOut(round)).toThrow(/at least one guess/);
  });

  it('pays nothing once busted, and refuses to play on', () => {
    let round = startHiLo(100, stream(4));
    // Guess the unlikely side repeatedly until it loses.
    for (let i = 0; i < MAX_STEPS && round.state === 'playing'; i += 1) {
      round = guess(round, rankOf(currentCard(round)) <= 6 ? 'lower' : 'higher');
    }
    expect(round.state).toBe('busted');
    expect(hiloPayout(round)).toBe(0);
    expect(() => guess(round, 'higher')).toThrow(HiLoError);
    expect(() => hiloCashOut(round)).toThrow(/nothing to cash out/);
  });

  it('caps a streak rather than letting the multiplier run away', () => {
    let round = startHiLo(100, stream(5));
    let guesses = 0;
    // Always take the safest side; on a fresh deck that survives a long time.
    while (round.state === 'playing' && guesses < MAX_STEPS + 5) {
      const choice: HiLoGuess = rankOf(currentCard(round)) <= 6 ? 'higher' : 'lower';
      round = guess(round, choice);
      guesses += 1;
    }
    expect(round.history.length).toBeLessThanOrEqual(MAX_STEPS);
    if (round.history.length === MAX_STEPS && round.state !== 'busted') {
      expect(round.state).toBe('cashed');
    }
  });

  it('replays identically from the same seed', () => {
    const play = (): number[] => {
      let round = startHiLo(100, stream(7));
      for (let i = 0; i < 5 && round.state === 'playing'; i += 1) {
        round = guess(round, 'higher');
      }
      return round.history.map((step) => step.card);
    };
    expect(play()).toEqual(play());
  });
});

// ----------------------------------------------------------------------- towers --

describe('tower odds', () => {
  it('has a survival chance that matches the tiles and traps', () => {
    for (const level of LEVELS) {
      const tiles = tilesPerRow(level);
      const traps = trapsPerRow(level);
      expect(rowChance(level)).toBeCloseTo((tiles - traps) / tiles, 12);
      expect(traps).toBeGreaterThan(0);
      expect(traps).toBeLessThan(tiles);
    }
  });

  it('gets harder and pays more as the difficulty climbs', () => {
    const ordered: Difficulty[] = ['easy', 'medium', 'hard', 'expert', 'master'];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(rowChance(ordered[i] as Difficulty))
        .toBeLessThan(rowChance(ordered[i - 1] as Difficulty));
      expect(multiplierFor(ordered[i] as Difficulty, ROWS))
        .toBeGreaterThan(multiplierFor(ordered[i - 1] as Difficulty, ROWS));
    }
  });

  /**
   * The identity the whole game is built on, asserted exactly at every height.
   *
   * `chance(k) * multiplier(k)` is the expected return of a plan that climbs to row `k`
   * and takes the money. If it were not flat, one height would be strictly better than
   * the others and the choice the game asks the player to make would be fake.
   */
  it('returns exactly 99% at every height, on every difficulty', () => {
    for (const level of LEVELS) {
      for (let rows = 1; rows <= ROWS; rows += 1) {
        const reaching = rowChance(level) ** rows;
        expect(reaching * multiplierFor(level, rows), `${level} row ${rows}`)
          .toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    }
  });

  it('has a table that runs from the first row to the top', () => {
    for (const level of LEVELS) {
      const table = multiplierTable(level);
      expect(table).toHaveLength(ROWS);
      expect(table[0]).toBeCloseTo(multiplierFor(level, 1), 12);
      expect(table[ROWS - 1]).toBeCloseTo(multiplierFor(level, ROWS), 12);
      // Strictly increasing: climbing is always worth more than stopping.
      for (let i = 1; i < table.length; i += 1) {
        expect(table[i]).toBeGreaterThan(table[i - 1] as number);
      }
    }
  });

  it('tops out where the odds say it should', () => {
    // Master is three traps in four tiles, eight times over: 1 in 65,536.
    expect(rowChance('master') ** ROWS).toBeCloseTo(1 / 65_536, 12);
    expect(multiplierFor('master', ROWS)).toBeCloseTo(0.99 * 65_536, 6);
    expect(multiplierFor('easy', ROWS)).toBeCloseTo(0.99 / 0.75 ** 8, 10);
  });
});

describe('climbing a tower', () => {
  it('lays every row up front, so the draws do not depend on how far you get', () => {
    // A round that ends on row one must leave the stream exactly where a cleared tower
    // would - otherwise the player's own play shifts the next round's cards.
    for (const level of LEVELS) {
      const source = stream(11);
      const before = source.bytesUsed;
      const round = startTowers(100, level, source);
      expect(round.traps).toHaveLength(ROWS);
      for (const row of round.traps) expect(row).toHaveLength(trapsPerRow(level));
      // Whatever the count is, it is fixed for the difficulty and spent at `start`.
      const used = source.bytesUsed - before;
      const again = stream(11);
      startTowers(100, level, again);
      expect(again.bytesUsed).toBe(used);
    }
  });

  it('pays the stake back untouched before any row is cleared', () => {
    const round = startTowers(250, 'medium', stream(12));
    expect(towersPayout(round)).toBe(250);
    expect(() => towersCashOut(round)).toThrow(/clear a row/);
  });

  it('climbs, and pays the multiplier for the height reached', () => {
    const round = startTowers(100, 'easy', stream(13));
    // Step onto a tile the round itself says is safe, one row at a time.
    let playing = round;
    for (let row = 0; row < 3; row += 1) {
      const traps = playing.traps[row] as number[];
      const safe = Array.from({ length: tilesPerRow('easy') }, (_, i) => i)
        .find((tile) => !traps.includes(tile)) as number;
      playing = climb(playing, safe);
      expect(playing.state).toBe('playing');
      expect(playing.picks).toHaveLength(row + 1);
    }
    expect(towersPayout(playing)).toBe(Math.floor(100 * multiplierFor('easy', 3)));
  });

  it('ends the round on a trap, and pays nothing', () => {
    let round = startTowers(100, 'hard', stream(14));
    const trap = (round.traps[0] as number[])[0] as number;
    round = climb(round, trap);
    expect(round.state).toBe('busted');
    expect(round.hit).toEqual({ row: 0, tile: trap });
    expect(towersPayout(round)).toBe(0);
    expect(() => climb(round, 0)).toThrow(TowersError);
  });

  it('cashes out automatically at the top', () => {
    let round = startTowers(100, 'easy', stream(15));
    for (let row = 0; row < ROWS; row += 1) {
      const traps = round.traps[row] as number[];
      const safe = Array.from({ length: tilesPerRow('easy') }, (_, i) => i)
        .find((tile) => !traps.includes(tile)) as number;
      round = climb(round, safe);
    }
    expect(round.state).toBe('cashed');
    expect(round.picks).toHaveLength(ROWS);
    expect(towersPayout(round)).toBe(Math.floor(100 * multiplierFor('easy', ROWS)));
  });

  it('refuses a tile that is not in the row', () => {
    const round = startTowers(100, 'hard', stream(16));
    expect(() => climb(round, -1)).toThrow(/no such tile/);
    expect(() => climb(round, tilesPerRow('hard'))).toThrow(/no such tile/);
    expect(() => startTowers(100, 'impossible' as Difficulty, stream(17))).toThrow(/difficulty/);
  });
});

// -------------------------------------------------------------- the two together --

describe('every cash-out point is worth the same', () => {
  /**
   * The claim both games make to the player, checked by enumeration.
   *
   * For towers this is exact arithmetic. For hi-lo it is the product of per-step
   * expectations, each of which the tests above pinned at exactly 0.99 - so a plan that
   * takes `n` steps returns 0.99^n of the stake whatever those steps are, and no
   * stopping point is secretly better than another.
   */
  it('holds for a multi-step plan, not just a single step', () => {
    for (const level of LEVELS) {
      for (let rows = 1; rows <= ROWS; rows += 1) {
        const ev = rowChance(level) ** rows * multiplierFor(level, rows);
        expect(ev).toBeCloseTo(1 - HOUSE_EDGE, 12);
      }
    }

    // Hi-lo: a two-step plan against known cards, enumerated over both draws.
    for (let firstRank = 0; firstRank < RANKS; firstRank += 1) {
      const first = makeCard(firstRank, 0);
      const choice: HiLoGuess = 'higher';
      let ev = 0;
      for (let second = 0; second < DECK_SIZE; second += 1) {
        if (!guessWins(first, second as Card, choice)) continue;
        const stepOne = stepMultiplier(first, choice);
        // Having survived, the second step is priced off the new card.
        const stepTwo = stepMultiplier(second as Card, choice);
        let inner = 0;
        for (let third = 0; third < DECK_SIZE; third += 1) {
          if (guessWins(second as Card, third as Card, choice)) inner += 1;
        }
        ev += (1 / DECK_SIZE) * stepOne * (inner / DECK_SIZE) * stepTwo;
      }
      expect(ev, `two steps from rank ${firstRank}`).toBeCloseTo((1 - HOUSE_EDGE) ** 2, 12);
    }
  });
});
