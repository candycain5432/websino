/**
 * A multi-deck shoe with a cut card.
 *
 * The whole shoe is shuffled from a single fair stream and then dealt in order. That is
 * the point of blackjack's per-shoe commitment: one `(serverSeed, clientSeed, nonce)`
 * fixes the entire sequence of cards for every round until the cut card comes out, so a
 * player can verify that the shoe was not restacked between their hands - which is the
 * only cheat that actually matters in blackjack.
 */

import type { FairSource } from '@websino/fair';

import { type Card, freshDeck } from './cards.js';

export interface ShoeState {
  cards: Card[];
  /** Index of the next card to deal. */
  position: number;
  /** Deal past this and the shoe is reshuffled before the next round. */
  cutCard: number;
  decks: number;
}

export class ShoeExhaustedError extends Error {}

/**
 * Shuffle a fresh shoe. `penetration` is the fraction dealt before the cut card.
 *
 * Draw order: one `shuffle()` of `decks * 52` cards, which is `decks * 52 - 1` calls to
 * `randBelow`, descending. Documented because the fairness verifier replays it.
 */
export function shuffleShoe(draw: FairSource, decks = 6, penetration = 0.75): ShoeState {
  const cards = draw.shuffle(freshDeck(decks));
  return {
    cards,
    position: 0,
    cutCard: Math.floor(cards.length * penetration),
    decks,
  };
}

export const needsShuffle = (shoe: ShoeState): boolean => shoe.position >= shoe.cutCard;

export const cardsRemaining = (shoe: ShoeState): number => shoe.cards.length - shoe.position;

/** Take the next card. Mutates `position` - a shoe is consumed, not copied. */
export function drawCard(shoe: ShoeState): Card {
  if (shoe.position >= shoe.cards.length) {
    throw new ShoeExhaustedError('the shoe is empty');
  }
  const card = shoe.cards[shoe.position] as Card;
  shoe.position += 1;
  return card;
}
