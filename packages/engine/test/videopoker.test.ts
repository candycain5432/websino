import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import { parseHand, type Card } from '../src/cards.js';
import {
  bestHold, classify, deal, drawCards, FLUSH, FOUR_OF_A_KIND, FULL_HOUSE, HAND_NAMES,
  HAND_SIZE, JACKS_OR_BETTER, MAX_COINS, PAY_ORDER, PAYTABLE, payoutForHand, ROYAL_FLUSH,
  setHolds, STRAIGHT, STRAIGHT_FLUSH, THREE_OF_A_KIND, TWO_PAIR, VideoPokerError,
  type PayingHand,
} from '../src/games/videopoker/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'f'.repeat(64), clientSeed: 'videopoker', nonce });

describe('classifying a hand', () => {
  const cases: Array<[string, string, string | null]> = [
    ['royal flush', 'As Ks Qs Js 10s', ROYAL_FLUSH],
    ['straight flush', '9h 8h 7h 6h 5h', STRAIGHT_FLUSH],
    ['wheel straight flush', 'Ah 2h 3h 4h 5h', STRAIGHT_FLUSH],
    ['four of a kind', '7s 7h 7d 7c 2s', FOUR_OF_A_KIND],
    ['full house', '5s 5h 5d 9c 9s', FULL_HOUSE],
    ['flush', 'As Js 8s 5s 2s', FLUSH],
    ['straight', '9s 8h 7d 6c 5s', STRAIGHT],
    ['wheel straight', 'As 2h 3d 4c 5s', STRAIGHT],
    ['three of a kind', '4s 4h 4d Kc 2s', THREE_OF_A_KIND],
    ['two pair', '3s 3h 9d 9c 2s', TWO_PAIR],
    ['jacks', 'Js Jh 9d 5c 2s', JACKS_OR_BETTER],
    ['queens', 'Qs Qh 9d 5c 2s', JACKS_OR_BETTER],
    ['aces', 'As Ah 9d 5c 2s', JACKS_OR_BETTER],
  ];

  for (const [name, hand, expected] of cases) {
    it(name, () => expect(classify(parseHand(hand))).toBe(expected));
  }

  const misses: Array<[string, string]> = [
    ['tens', '10s 10h 9d 5c 2s'],
    ['a low pair', '3s 3h 9d 5c 2s'],
    ['nothing at all', 'Ks 9h 7d 5c 2s'],
  ];

  for (const [name, hand] of misses) {
    it(`pays nothing for ${name}`, () => expect(classify(parseHand(hand))).toBeNull());
  }

  it('separates the royal from an ordinary straight flush', () => {
    expect(classify(parseHand('As Ks Qs Js 10s'))).toBe(ROYAL_FLUSH);
    expect(classify(parseHand('Ks Qs Js 10s 9s'))).toBe(STRAIGHT_FLUSH);
  });

  it('refuses a hand that is not five cards', () => {
    expect(() => classify(parseHand('As Ks'))).toThrow(VideoPokerError);
  });
});

describe('the paytable', () => {
  it('is the full-pay 9/6 schedule', () => {
    expect(PAYTABLE[FULL_HOUSE][0]).toBe(9);
    expect(PAYTABLE[FLUSH][0]).toBe(6);
  });

  it('scales linearly except for the royal at five coins', () => {
    for (const hand of PAY_ORDER) {
      const pays = PAYTABLE[hand];
      const perCoin = pays[0] as number;
      for (let coins = 1; coins <= MAX_COINS; coins += 1) {
        const expected = hand === ROYAL_FLUSH && coins === MAX_COINS
          ? 4000
          : perCoin * coins;
        expect(pays[coins - 1]).toBe(expected);
      }
    }
  });

  it('gives the royal its jump only at max coins - the one reason to bet max', () => {
    expect((PAYTABLE[ROYAL_FLUSH][4] as number) / MAX_COINS).toBe(800);
    expect((PAYTABLE[ROYAL_FLUSH][3] as number) / 4).toBe(250);
  });

  it('names every paying hand', () => {
    for (const hand of PAY_ORDER) expect(HAND_NAMES[hand]).toBeTruthy();
  });

  it('pays nothing for a missed hand', () => {
    expect(payoutForHand(null, 5, 10)).toBe(0);
  });

  it('multiplies by the coin value', () => {
    expect(payoutForHand(FLUSH, 1, 10)).toBe(60);
    expect(payoutForHand(FLUSH, 5, 10)).toBe(300);
  });
});

describe('dealing and drawing', () => {
  it('deals five cards and stakes coins times coin value', () => {
    const round = deal(5, 10, stream(1));
    expect(round.cards).toHaveLength(HAND_SIZE);
    expect(new Set(round.cards).size).toBe(HAND_SIZE);
    expect(round.phase).toBe('holding');
    expect(round.coins * round.coinValue).toBe(50);
  });

  it('rejects an illegal coin count or value', () => {
    expect(() => deal(0, 10, stream(1))).toThrow(VideoPokerError);
    expect(() => deal(6, 10, stream(1))).toThrow(VideoPokerError);
    expect(() => deal(5, 0, stream(1))).toThrow(VideoPokerError);
  });

  it('replaces exactly the unheld cards', () => {
    const dealt = deal(5, 10, stream(2));
    const held = [true, false, true, false, true];
    const done = drawCards(setHolds(dealt, held));

    expect(done.drawn).toEqual([1, 3]);
    for (let i = 0; i < HAND_SIZE; i += 1) {
      if (held[i]) expect(done.cards[i]).toBe(dealt.cards[i]);
    }
    expect(new Set(done.cards).size).toBe(HAND_SIZE);
  });

  it('draws replacements from the same deck, so nothing repeats', () => {
    for (let nonce = 0; nonce < 300; nonce += 1) {
      const done = drawCards(setHolds(deal(5, 10, stream(nonce)), [false, false, false, false, false]));
      expect(new Set(done.cards).size).toBe(HAND_SIZE);
    }
  });

  it('fixes the whole round before the player chooses holds', () => {
    // Holding nothing and holding everything must draw from the same shuffled deck,
    // so the replacements cannot be chosen after seeing the holds.
    const a = deal(5, 10, stream(4));
    const b = deal(5, 10, stream(4));
    expect(a.deck).toEqual(b.deck);
    expect(drawCards(setHolds(a, [false, true, false, true, false])).cards[0])
      .toBe(b.deck[HAND_SIZE]);
  });

  it('settles into a payout', () => {
    const done = drawCards(setHolds(deal(5, 10, stream(5)), [true, true, true, true, true]));
    expect(done.phase).toBe('complete');
    expect(done.payout).toBe(payoutForHand(done.result, 5, 10));
  });

  it('refuses to draw twice or hold after the draw', () => {
    const done = drawCards(setHolds(deal(5, 10, stream(6)), [true, true, true, true, true]));
    expect(() => drawCards(done)).toThrow(/nothing to draw/);
    expect(() => setHolds(done, [true, true, true, true, true])).toThrow(/no hand to hold/);
  });

  it('refuses a hold mask that is the wrong length', () => {
    expect(() => setHolds(deal(5, 10, stream(7)), [true, false])).toThrow(/five cards/);
  });

  it('is reproducible from the seed', () => {
    expect(deal(5, 10, stream(11)).cards).toEqual(deal(5, 10, stream(11)).cards);
  });
});

describe('the hint', () => {
  /** A deterministic stand-in for Math.random, so the hint is testable. */
  const fakeRandom = (): (() => number) => {
    let state = 12345;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  };

  const hold = (hand: string): boolean[] => bestHold(parseHand(hand), fakeRandom(), 400);

  it('keeps a made royal flush', () => {
    expect(hold('As Ks Qs Js 10s')).toEqual([true, true, true, true, true]);
  });

  it('keeps four of a kind and throws the kicker', () => {
    expect(hold('7s 7h 7d 7c 2s')).toEqual([true, true, true, true, false]);
  });

  it('keeps a made flush', () => {
    expect(hold('As Js 8s 5s 2s')).toEqual([true, true, true, true, true]);
  });

  it('keeps a high pair and draws three', () => {
    expect(hold('Ks Kh 9d 5c 2s')).toEqual([true, true, false, false, false]);
  });

  it('throws everything from a hand with nothing in it', () => {
    // 2-5-7-9-J offsuit with no draw worth keeping - a jack alone is the most it has.
    const mask = hold('2s 5h 7d 9c Jh');
    expect(mask.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('never touches the fair stream', () => {
    // The signature takes a plain `() => number`, so the fair source cannot be passed
    // here at all. pysino's hint drew from the deal's own generator, which meant asking
    // for advice changed the cards it was advising about.
    const s = stream(3);
    const round = deal(5, 10, s);
    const before = s.bytesUsed;
    bestHold(round.cards, fakeRandom(), 100);
    expect(s.bytesUsed).toBe(before);
  });

  it('returns a mask of exactly five booleans', () => {
    for (let nonce = 0; nonce < 25; nonce += 1) {
      const mask = bestHold(deal(5, 10, stream(nonce)).cards, fakeRandom(), 120);
      expect(mask).toHaveLength(HAND_SIZE);
      for (const value of mask) expect(typeof value).toBe('boolean');
    }
  });

  it('refuses a hand that is not five cards', () => {
    expect(() => bestHold(parseHand('As Ks') as Card[])).toThrow(VideoPokerError);
  });
});

/**
 * Dealt-hand frequencies against the exact five-card poker probabilities.
 *
 * This is a better test than return to player, and a far cheaper one. RTP is dominated
 * by royal flushes at about 1 in 40,000, so any sample small enough to run in CI is
 * really measuring whether a royal happened to land - an earlier version of this test
 * failed at 1.153 for precisely that reason, having caught one.
 *
 * Dealt-hand frequencies are exactly known (`n / C(52,5)`), converge in thousands rather
 * than millions, need no hint, and pin the two things that could actually break: the
 * classifier and the uniformity of the shuffle.
 *
 * For the record, measured separately over 20,000 played hands with the sampling hint:
 * 96.84% return, against the 99.54% a perfect player gets on this paytable. The gap is
 * the hint sampling its wider draws, not the engine.
 */
describe('dealt-hand frequencies match the exact odds', () => {
  const C52_5 = 2_598_960;
  // Counts of each five-card hand in a full deck, from the standard enumeration.
  const EXPECTED: Array<[string, number]> = [
    [TWO_PAIR, 123_552 / C52_5],
    [THREE_OF_A_KIND, 54_912 / C52_5],
    [STRAIGHT, 10_200 / C52_5],
    [FLUSH, 5_108 / C52_5],
    [FULL_HOUSE, 3_744 / C52_5],
    // One pair is 1,098,240 hands; exactly 4 of the 13 ranks pay here.
    [JACKS_OR_BETTER, (1_098_240 * 4) / 13 / C52_5],
  ];

  const ROUNDS = 40_000;
  const tally = new Map<string, number>();
  for (let nonce = 0; nonce < ROUNDS; nonce += 1) {
    const result = classify(deal(MAX_COINS, 1, stream(nonce)).cards);
    if (result) tally.set(result, (tally.get(result) ?? 0) + 1);
  }

  for (const [hand, expected] of EXPECTED) {
    it(`${HAND_NAMES[hand as PayingHand]} at ${(expected * 100).toFixed(3)}%`, () => {
      const observed = (tally.get(hand) ?? 0) / ROUNDS;
      const sigma = Math.sqrt((expected * (1 - expected)) / ROUNDS);
      expect(Math.abs(observed - expected)).toBeLessThan(4 * sigma);
    });
  }

  it('deals a paying hand about 20% of the time', () => {
    const paying = [...tally.values()].reduce((a, b) => a + b, 0);
    // Everything above jacks-or-better, plus the rarer hands - close to 20.6%.
    expect(paying / ROUNDS).toBeGreaterThan(0.17);
    expect(paying / ROUNDS).toBeLessThan(0.24);
  });
});

describe('the hint beats holding nothing', () => {
  it('returns more than a player who redraws every hand', () => {
    // A cheap, direct check that the advice is worth taking, without needing an RTP
    // measurement: same seeds, same stakes, one player follows the hint and one throws
    // the whole hand away every time.
    const rounds = 250;
    let state = 24680;
    const random = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };

    let advised = 0;
    let blind = 0;
    for (let nonce = 0; nonce < rounds; nonce += 1) {
      const a = deal(MAX_COINS, 1, stream(nonce));
      advised += drawCards(setHolds(a, bestHold(a.cards, random, 30))).payout;
      const b = deal(MAX_COINS, 1, stream(nonce));
      blind += drawCards(setHolds(b, [false, false, false, false, false])).payout;
    }
    expect(advised).toBeGreaterThan(blind);
  });

  it('never pays for a hand the paytable does not list', () => {
    for (let nonce = 0; nonce < 1500; nonce += 1) {
      const done = drawCards(setHolds(deal(5, 10, stream(nonce)), [true, true, true, true, true]));
      if (done.result === null) expect(done.payout).toBe(0);
      else expect(done.payout).toBeGreaterThan(0);
    }
  });
});
