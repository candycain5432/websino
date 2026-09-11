/**
 * Cards as packed integers.
 *
 * `pysino` used a frozen dataclass compared by value, and leaned on that hard:
 * `set(hole) | set(board)`, `card not in known`, `deck.remove(card)`. JavaScript
 * compares objects by reference, so all of that would silently break. Encoding a card
 * as a single integer restores value semantics for free - `Set<number>` and `Map`
 * behave, equality is `===`, and the wire format is one byte instead of an object.
 *
 *   card = rank * 4 + suit,  rank 0..12 = 2,3,...,10,J,Q,K,A,  suit 0..3 = S,H,D,C
 */

export type Card = number;

export const RANKS = 13;
export const SUITS = 4;
export const DECK_SIZE = RANKS * SUITS;

export const SUIT_SPADE = 0;
export const SUIT_HEART = 1;
export const SUIT_DIAMOND = 2;
export const SUIT_CLUB = 3;

const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const SUIT_LABELS = ['s', 'h', 'd', 'c'] as const;
const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'] as const;

export const makeCard = (rank: number, suit: number): Card => rank * SUITS + suit;
export const rankOf = (card: Card): number => Math.floor(card / SUITS);
export const suitOf = (card: Card): number => card % SUITS;

/** True for hearts and diamonds - the red suits. */
export const isRed = (card: Card): boolean =>
  suitOf(card) === SUIT_HEART || suitOf(card) === SUIT_DIAMOND;

export const rankLabel = (card: Card): string => RANK_LABELS[rankOf(card)] as string;
export const suitLabel = (card: Card): string => SUIT_LABELS[suitOf(card)] as string;
export const suitSymbol = (card: Card): string => SUIT_SYMBOLS[suitOf(card)] as string;

/** `"As"`, `"10h"`, `"2c"` - the shorthand used in tests and logs. */
export const cardName = (card: Card): string => `${rankLabel(card)}${suitLabel(card)}`;

/** Parse `"As"`, `"Td"`, `"10h"` back into a card. Throws on nonsense. */
export function parseCard(text: string): Card {
  const trimmed = text.trim();
  if (trimmed.length < 2) throw new Error(`cannot parse card: ${text}`);

  const suitChar = trimmed.slice(-1).toLowerCase();
  const suit = SUIT_LABELS.indexOf(suitChar as (typeof SUIT_LABELS)[number]);
  if (suit < 0) throw new Error(`bad suit in ${text}`);

  let rankText = trimmed.slice(0, -1).toUpperCase();
  if (rankText === 'T') rankText = '10';
  const rank = RANK_LABELS.indexOf(rankText as (typeof RANK_LABELS)[number]);
  if (rank < 0) throw new Error(`bad rank in ${text}`);

  return makeCard(rank, suit);
}

/** Parse a whitespace-separated hand: `"As Kd 10h"`. */
export const parseHand = (text: string): Card[] =>
  text.split(/\s+/).filter(Boolean).map(parseCard);

export const handName = (cards: readonly Card[]): string => cards.map(cardName).join(' ');

/** `decks` packs of 52, unshuffled. */
export function freshDeck(decks = 1): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < decks; d += 1) {
    for (let c = 0; c < DECK_SIZE; c += 1) out.push(c);
  }
  return out;
}

/** Face cards count ten, an ace counts eleven until it has to shrink. */
export function blackjackValue(card: Card): number {
  const rank = rankOf(card);
  if (rank === 12) return 11; // ace
  return rank >= 8 ? 10 : rank + 2; // 10,J,Q,K all ten; otherwise pip value
}

export const isAce = (card: Card): boolean => rankOf(card) === 12;
