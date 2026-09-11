import { describe, expect, it } from 'vitest';

import { parseHand } from '../src/cards.js';
import {
  compare, describe as describeHand, evaluate, FLUSH, FOUR_OF_A_KIND, FULL_HOUSE,
  HIGH_CARD, PAIR, STRAIGHT, STRAIGHT_FLUSH, THREE_OF_A_KIND, TWO_PAIR,
} from '../src/handEval.js';

const rank = (hand: string) => evaluate(parseHand(hand));

describe('categories', () => {
  it.each([
    ['As Ks Qs Js 10s', STRAIGHT_FLUSH],
    ['5s 4s 3s 2s As', STRAIGHT_FLUSH],
    ['7h 7d 7c 7s 2h', FOUR_OF_A_KIND],
    ['Kh Kd Kc 7s 7h', FULL_HOUSE],
    ['Ah Kh 9h 5h 2h', FLUSH],
    ['9h 8d 7c 6s 5h', STRAIGHT],
    ['Ah 2d 3c 4s 5h', STRAIGHT],
    ['Ah Ad Ac 5s 9h', THREE_OF_A_KIND],
    ['Ah Ad Kc Ks 9h', TWO_PAIR],
    ['Ah Ad Kc 9s 7h', PAIR],
    ['Ah Kd Qc 9s 7h', HIGH_CARD],
  ])('classifies %s', (hand, category) => {
    expect(rank(hand).category).toBe(category);
  });
});

describe('descriptions', () => {
  it.each([
    ['As Ks Qs Js 10s 2h 3d', 'Royal Flush'],
    ['5s 4s 3s 2s As Kh Qd', 'Straight Flush, 5 high'],
    ['7h 7d 7c 7s 2h 3d 4c', 'Four Sevens'],
    ['Kh Kd Kc 7s 7h 2d 3c', 'Kings full of Sevens'],
    ['Ah Kh 9h 5h 2h 3d 4c', 'Flush, A high'],
    ['Ah 2d 3c 4s 5h Kd Qc', 'Straight, 5 high'],
    ['Ah Ad Ac 5s 9h 2d 3c', 'Three Aces'],
    ['Ah Ad Kc Ks 9h 2d 3c', 'Two Pair, Aces and Kings'],
    ['Ah Ad Kc 9s 7h 2d 3c', 'Pair of Aces'],
    ['Ah Kd Qc 9s 7h 2d 3c', 'A high'],
  ])('describes %s', (hand, expected) => {
    expect(describeHand(rank(hand))).toBe(expected);
  });
});

describe('best five from seven', () => {
  it('finds the royal inside seven cards', () => {
    const r = rank('As Ks Qs Js 10s 2h 3d');
    expect(r.category).toBe(STRAIGHT_FLUSH);
    expect(r.cards).toHaveLength(5);
  });

  it('does not invent a straight flush from mixed suits', () => {
    // Five spades AND a separate straight present - the flush must win, not a
    // phantom straight flush stitched from both. This was a real trap in pysino.
    expect(rank('2s 4s 6s 8s 10s 3h 5d').category).toBe(FLUSH);
  });

  it('keeps the top two of three pairs', () => {
    expect(rank('Ah Ad Kc Ks 9h 9d 3c').tiebreakers).toEqual([12, 11, 7]);
  });

  it('uses the lower trips as the pair when dealt two sets', () => {
    expect(describeHand(rank('Kh Kd Kc 7s 7h 7d 2c'))).toBe('Kings full of Sevens');
  });
});

describe('ordering', () => {
  it('ranks the wheel below a six-high straight', () => {
    expect(compare(parseHand('Ah 2d 3c 4s 5h'), parseHand('2h 3d 4c 5s 6h'))).toBe(-1);
  });

  it('ranks an ace-high straight above a king-high one', () => {
    expect(compare(parseHand('Ah Kd Qc Js 10h'), parseHand('Kh Qd Jc 10s 9h'))).toBe(1);
  });

  it('breaks ties on kickers and splits genuine ties', () => {
    expect(compare(parseHand('Ah Ad Kc 9s 7h'), parseHand('As Ac Qd 9h 7s'))).toBe(1);
    expect(compare(parseHand('Ah Ad Kc 9s 7h'), parseHand('As Ac Kd 9h 7s'))).toBe(0);
  });

  it('ranks a flush over a straight and a straight flush over quads', () => {
    expect(compare(parseHand('2h 5h 9h Jh Kh'), parseHand('9h 8d 7c 6s 5h'))).toBe(1);
    expect(compare(parseHand('9s 8s 7s 6s 5s'), parseHand('7h 7d 7c 7s 2h'))).toBe(1);
  });

  it('packs values in the same order as the categories', () => {
    const hands = [
      'Ah Kd Qc 9s 7h', 'Ah Ad Kc 9s 7h', 'Ah Ad Kc Ks 9h', 'Ah Ad Ac 5s 9h',
      '9h 8d 7c 6s 5h', 'Ah Kh 9h 5h 2h', 'Kh Kd Kc 7s 7h', '7h 7d 7c 7s 2h',
      'As Ks Qs Js 10s',
    ];
    const values = hands.map((h) => rank(h).value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

describe('robustness', () => {
  it('refuses fewer than five cards', () => {
    expect(() => evaluate(parseHand('Ah Kd Qc'))).toThrow();
  });

  it('describes every five-card hand from a slice of the deck without crashing', () => {
    const deck = Array.from({ length: 14 }, (_, i) => i);
    let count = 0;
    for (let a = 0; a < deck.length; a += 1)
      for (let b = a + 1; b < deck.length; b += 1)
        for (let c = b + 1; c < deck.length; c += 1)
          for (let d = c + 1; d < deck.length; d += 1)
            for (let e = d + 1; e < deck.length; e += 1) {
              expect(describeHand(evaluate([a, b, c, d, e]))).toBeTruthy();
              count += 1;
            }
    expect(count).toBe(2002);
  });
});
