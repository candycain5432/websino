import { describe, expect, it } from 'vitest';

import {
  blackjackValue, cardName, DECK_SIZE, freshDeck, isAce, isRed, makeCard,
  parseCard, parseHand, rankOf, suitOf,
} from '../src/cards.js';
import { comb, combinations } from '../src/util/combinatorics.js';
import { mod } from '../src/util/mod.js';

describe('card packing', () => {
  it('round-trips every card through rank and suit', () => {
    for (let card = 0; card < DECK_SIZE; card += 1) {
      expect(makeCard(rankOf(card), suitOf(card))).toBe(card);
    }
  });

  it('gives 52 distinct cards', () => {
    expect(new Set(freshDeck()).size).toBe(52);
  });

  it('stacks multiple decks', () => {
    const shoe = freshDeck(6);
    expect(shoe).toHaveLength(312);
    expect(new Set(shoe).size).toBe(52);
  });

  it('has value semantics, which objects would not', () => {
    // The whole reason cards are integers: Set and === just work.
    const hole = [parseCard('As'), parseCard('Kd')];
    const known = new Set(hole);
    expect(known.has(parseCard('As'))).toBe(true);
    expect(known.has(parseCard('Ah'))).toBe(false);
  });
});

describe('parsing and naming', () => {
  it.each([
    ['As', 12, 0], ['10h', 8, 1], ['Td', 8, 2], ['2c', 0, 3], ['kS', 11, 0],
  ])('parses %s', (text, rank, suit) => {
    expect(parseCard(text)).toBe(makeCard(rank, suit));
  });

  it.each(['', 'X', '1s', 'Ax', '15h'])('rejects %s', (text) => {
    expect(() => parseCard(text)).toThrow();
  });

  it('round-trips through its own name', () => {
    for (let card = 0; card < DECK_SIZE; card += 1) {
      expect(parseCard(cardName(card))).toBe(card);
    }
  });

  it('parses a whole hand', () => {
    expect(parseHand('As Kd 10h').map(cardName)).toEqual(['As', 'Kd', '10h']);
  });
});

describe('card properties', () => {
  it('scores blackjack values', () => {
    expect(blackjackValue(parseCard('As'))).toBe(11);
    expect(blackjackValue(parseCard('Ks'))).toBe(10);
    expect(blackjackValue(parseCard('10s'))).toBe(10);
    expect(blackjackValue(parseCard('7s'))).toBe(7);
    expect(blackjackValue(parseCard('2s'))).toBe(2);
  });

  it('knows red from black', () => {
    expect(isRed(parseCard('Ah'))).toBe(true);
    expect(isRed(parseCard('Ad'))).toBe(true);
    expect(isRed(parseCard('As'))).toBe(false);
    expect(isRed(parseCard('Ac'))).toBe(false);
  });

  it('spots aces', () => {
    expect(isAce(parseCard('Ah'))).toBe(true);
    expect(isAce(parseCard('Kh'))).toBe(false);
  });
});

describe('python-ism replacements', () => {
  it('mod matches Python floored modulo, unlike raw %', () => {
    // -53 % 8 is 3 in Python and -5 in JS. This bit pysino's ported RNG.
    expect(mod(-53, 8)).toBe(3);
    expect(-53 % 8).toBe(-5);
    expect(mod(53, 8)).toBe(5);
  });

  it('comb matches math.comb', () => {
    expect(comb(25, 3)).toBe(2300);
    expect(comb(52, 5)).toBe(2598960);
    expect(comb(5, 0)).toBe(1);
    expect(comb(3, 5)).toBe(0);
  });

  it('combinations enumerates like itertools', () => {
    expect([...combinations([1, 2, 3, 4], 2)]).toEqual([
      [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4],
    ]);
    expect([...combinations([1, 2, 3], 0)]).toEqual([[]]);
    expect([...combinations([1, 2], 3)]).toEqual([]);
  });
});
