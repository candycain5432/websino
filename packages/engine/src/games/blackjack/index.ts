/**
 * Blackjack: six-deck shoe, splits, doubles, insurance and late surrender.
 *
 * House rules follow a common Vegas shoe game - dealer stands on soft 17, blackjack pays
 * 3:2, double on any two cards, double after split, split to four hands, split aces take
 * one card each. The knobs live in `Rules` so a table (or a test) can change them.
 *
 * **Fairness.** The commitment is per *shoe*, not per round: one stream shuffles all 312
 * cards and rounds deal from it in order. Committing per round would be weaker, not
 * stronger - it would let the house reshuffle between hands, which is the one thing a
 * blackjack player actually needs ruled out.
 *
 * Ported from pysino's `games/blackjack.py`, with cards as packed integers and the
 * mutable game object replaced by explicit state so the server can persist a hand
 * mid-round and a reconnect can pick it up exactly where it left off.
 */

import { blackjackValue, type Card, isAce } from '../../cards.js';
import { drawCard, needsShuffle, type ShoeState } from '../../shoe.js';

/**
 * A move the rules do not allow in this position.
 *
 * Typed rather than a bare `Error` so the server can answer 400 instead of 500: a client
 * asking to split a 7 and a King is making a mistake, not exposing a server fault, and
 * logging it as one buries real errors in noise.
 */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

export type Action = 'hit' | 'stand' | 'double' | 'split' | 'surrender';
export type Phase = 'insurance' | 'player' | 'done';
export type Outcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust' | 'surrender';

export interface Rules {
  decks: number;
  penetration: number;
  dealerHitsSoft17: boolean;
  blackjackPayout: number;
  maxHands: number;
  doubleAfterSplit: boolean;
  allowSurrender: boolean;
  /** Split aces draw exactly one card each and may not be re-split. */
  oneCardAfterSplitAces: boolean;
}

export const DEFAULT_RULES: Rules = {
  decks: 6,
  penetration: 0.75,
  dealerHitsSoft17: false,
  blackjackPayout: 1.5,
  maxHands: 4,
  doubleAfterSplit: true,
  allowSurrender: true,
  oneCardAfterSplitAces: true,
};

export interface Hand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  fromSplit: boolean;
  splitAces: boolean;
  stood: boolean;
  surrendered: boolean;
  outcome: Outcome | null;
  payout: number;
}

export interface BlackjackRound {
  hands: Hand[];
  dealer: Card[];
  activeIndex: number;
  phase: Phase;
  insuranceBet: number;
  insurancePayout: number;
  holeHidden: boolean;
  rules: Rules;
  /** Chips committed so far: every hand's bet plus insurance. */
  staked: number;
  returned: number;
}

/** `[total, isSoft]`. Aces drop from 11 to 1 as needed. */
export function handValue(cards: readonly Card[]): [number, boolean] {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += blackjackValue(card);
    if (isAce(card)) aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return [total, aces > 0 && total <= 21];
}

export const totalOf = (cards: readonly Card[]): number => handValue(cards)[0];
export const isSoft = (cards: readonly Card[]): boolean => handValue(cards)[1];

const makeHand = (bet: number, cards: Card[] = [], extra: Partial<Hand> = {}): Hand => ({
  cards,
  bet,
  doubled: false,
  fromSplit: false,
  splitAces: false,
  stood: false,
  surrendered: false,
  outcome: null,
  payout: 0,
  ...extra,
});

export const isBusted = (hand: Hand): boolean => totalOf(hand.cards) > 21;

/** Two-card 21, which a hand created by a split can never be. */
export const isBlackjack = (hand: Hand): boolean =>
  hand.cards.length === 2 && totalOf(hand.cards) === 21 && !hand.fromSplit;

export const isFinished = (hand: Hand): boolean =>
  hand.stood || hand.surrendered || isBusted(hand) || totalOf(hand.cards) === 21;

export const canSplit = (hand: Hand): boolean =>
  hand.cards.length === 2 &&
  blackjackValue(hand.cards[0] as Card) === blackjackValue(hand.cards[1] as Card) &&
  !hand.splitAces;

/** `"Blackjack"`, `"Bust (23)"`, `"7/17"` for a soft hand, else the total. */
export function handLabel(hand: Hand): string {
  const [total, soft] = handValue(hand.cards);
  if (isBlackjack(hand)) return 'Blackjack';
  if (total > 21) return `Bust (${total})`;
  if (soft && total !== 21) return `${total - 10}/${total}`;
  return String(total);
}

export const dealerTotal = (round: BlackjackRound): number => totalOf(round.dealer);

export const dealerHasBlackjack = (round: BlackjackRound): boolean =>
  round.dealer.length === 2 && dealerTotal(round) === 21;

export const dealerUpcard = (round: BlackjackRound): Card | null => round.dealer[0] ?? null;

export const insuranceCost = (round: BlackjackRound): number =>
  Math.floor((round.hands[0]?.bet ?? 0) / 2);

/**
 * Deal a new round from `shoe`. Reshuffles first if the cut card is out, which is why
 * the caller passes a reshuffle function rather than a bare shoe - a new shoe means a
 * new fairness commitment, and only the caller knows how to mint one.
 */
export function deal(
  shoe: ShoeState,
  bet: number,
  rules: Rules = DEFAULT_RULES,
): BlackjackRound {
  if (!Number.isInteger(bet) || bet <= 0) throw new IllegalActionError('bet must be a positive integer');

  const round: BlackjackRound = {
    hands: [makeHand(bet)],
    dealer: [],
    activeIndex: 0,
    phase: 'player',
    insuranceBet: 0,
    insurancePayout: 0,
    holeHidden: true,
    rules,
    staked: bet,
    returned: 0,
  };

  for (let i = 0; i < 2; i += 1) {
    (round.hands[0] as Hand).cards.push(drawCard(shoe));
    round.dealer.push(drawCard(shoe));
  }

  const up = dealerUpcard(round);
  if (up !== null && isAce(up)) {
    round.phase = 'insurance';
    return round;
  }
  return peekForNaturals(round);
}

/** The dealer checks the hole card; a natural on either side ends the round at once. */
function peekForNaturals(round: BlackjackRound): BlackjackRound {
  if (dealerHasBlackjack(round) || isBlackjack(round.hands[0] as Hand)) {
    round.holeHidden = false;
    return settle(round);
  }
  round.phase = 'player';
  return round;
}

export function takeInsurance(round: BlackjackRound, buy: boolean): BlackjackRound {
  if (round.phase !== 'insurance') throw new IllegalActionError('insurance is not on offer');
  if (buy) {
    round.insuranceBet = insuranceCost(round);
    round.staked += round.insuranceBet;
    // Insurance pays 2:1, so a winning bet returns three times the stake.
    if (dealerHasBlackjack(round)) round.insurancePayout = round.insuranceBet * 3;
  }
  return peekForNaturals(round);
}

export function activeHand(round: BlackjackRound): Hand | null {
  if (round.phase !== 'player' || round.activeIndex >= round.hands.length) return null;
  return round.hands[round.activeIndex] as Hand;
}

export function availableActions(round: BlackjackRound): Action[] {
  const hand = activeHand(round);
  if (hand === null) return [];

  const actions: Action[] = ['hit', 'stand'];
  const firstDecision = hand.cards.length === 2;

  if (firstDecision && (round.rules.doubleAfterSplit || !hand.fromSplit)) actions.push('double');
  if (canSplit(hand) && round.hands.length < round.rules.maxHands) actions.push('split');
  if (
    round.rules.allowSurrender &&
    firstDecision &&
    !hand.fromSplit &&
    round.hands.length === 1
  ) {
    actions.push('surrender');
  }
  return actions;
}

/**
 * Apply a player action. Throws if it is not currently legal - the server calls this
 * and never trusts the client's idea of which buttons were enabled.
 */
export function act(round: BlackjackRound, action: Action, shoe: ShoeState): BlackjackRound {
  if (round.phase !== 'player') throw new IllegalActionError(`cannot act in phase ${round.phase}`);
  if (!availableActions(round).includes(action)) {
    throw new IllegalActionError(`${action} is not available right now`);
  }
  const hand = activeHand(round) as Hand;

  switch (action) {
    case 'hit':
      hand.cards.push(drawCard(shoe));
      break;

    case 'stand':
      hand.stood = true;
      break;

    case 'double':
      round.staked += hand.bet;
      hand.bet += hand.bet;
      hand.doubled = true;
      hand.cards.push(drawCard(shoe));
      hand.stood = true;
      break;

    case 'surrender':
      hand.surrendered = true;
      break;

    case 'split': {
      const moved = hand.cards.pop() as Card;
      const splitAces = isAce(moved) && round.rules.oneCardAfterSplitAces;
      const newHand = makeHand(hand.bet, [moved], { fromSplit: true, splitAces });
      hand.fromSplit = true;
      hand.splitAces = splitAces;
      round.staked += newHand.bet;
      round.hands.splice(round.activeIndex + 1, 0, newHand);

      hand.cards.push(drawCard(shoe));
      newHand.cards.push(drawCard(shoe));

      if (splitAces) {
        // Split aces get one card each and are done immediately.
        hand.stood = true;
        newHand.stood = true;
      }
      break;
    }
  }

  return advance(round, shoe);
}

/** Move to the next unfinished hand, or hand play over to the dealer. */
function advance(round: BlackjackRound, shoe: ShoeState): BlackjackRound {
  while (round.activeIndex < round.hands.length) {
    if (!isFinished(round.hands[round.activeIndex] as Hand)) return round;
    round.activeIndex += 1;
  }
  return playDealer(round, shoe);
}

export function dealerMustDraw(round: BlackjackRound): boolean {
  const [total, soft] = handValue(round.dealer);
  if (total < 17) return true;
  return total === 17 && soft && round.rules.dealerHitsSoft17;
}

function playDealer(round: BlackjackRound, shoe: ShoeState): BlackjackRound {
  round.holeHidden = false;
  // The dealer only draws if some hand can still be beaten. Drawing to a table of
  // busted hands would burn cards from a shoe the player is entitled to verify.
  const live = round.hands.some((h) => !isBusted(h) && !h.surrendered);
  if (live) {
    while (dealerMustDraw(round)) round.dealer.push(drawCard(shoe));
  }
  return settle(round);
}

function settle(round: BlackjackRound): BlackjackRound {
  const dealerPoints = dealerTotal(round);
  const dealerBj = dealerHasBlackjack(round);
  const dealerBust = dealerPoints > 21;
  let returned = 0;

  for (const hand of round.hands) {
    if (hand.surrendered) {
      hand.outcome = 'surrender';
      hand.payout = Math.floor(hand.bet / 2);
    } else if (isBusted(hand)) {
      hand.outcome = 'bust';
      hand.payout = 0;
    } else if (isBlackjack(hand) && !dealerBj) {
      hand.outcome = 'blackjack';
      hand.payout = hand.bet + Math.floor(hand.bet * round.rules.blackjackPayout);
    } else if (dealerBj && !isBlackjack(hand)) {
      hand.outcome = 'lose';
      hand.payout = 0;
    } else if (dealerBj && isBlackjack(hand)) {
      hand.outcome = 'push';
      hand.payout = hand.bet;
    } else if (dealerBust || totalOf(hand.cards) > dealerPoints) {
      hand.outcome = 'win';
      hand.payout = hand.bet * 2;
    } else if (totalOf(hand.cards) < dealerPoints) {
      hand.outcome = 'lose';
      hand.payout = 0;
    } else {
      hand.outcome = 'push';
      hand.payout = hand.bet;
    }
    returned += hand.payout;
  }

  round.returned = returned + round.insurancePayout;
  round.phase = 'done';
  return round;
}

export const roundNeedsShuffle = (shoe: ShoeState): boolean => needsShuffle(shoe);

/**
 * Textbook basic strategy, restricted to the actions actually on offer so the advice
 * is never illegal.
 *
 * This runs on the *client* and must never touch the fair stream. pysino's equivalent
 * hint drew from the same generator as the deal, so pressing the hint button changed
 * the cards it was advising about. Here it is a pure function of visible state, which
 * makes that mistake impossible rather than merely avoided.
 */
export function basicStrategy(hand: Hand, dealerUp: Card, actions: readonly Action[]): Action {
  const [total, soft] = handValue(hand.cards);
  const up = isAce(dealerUp) ? 11 : blackjackValue(dealerUp);

  const pick = (...preferences: Action[]): Action => {
    for (const choice of preferences) if (actions.includes(choice)) return choice;
    return actions.includes('stand') ? 'stand' : 'hit';
  };

  if (canSplit(hand) && actions.includes('split')) {
    const first = hand.cards[0] as Card;
    const rank = blackjackValue(first);
    if (isAce(first)) return 'split';
    if (rank === 8) return 'split';
    if ((rank === 2 || rank === 3 || rank === 7) && up <= 7) return 'split';
    if (rank === 6 && up <= 6) return 'split';
    if (rank === 9 && [2, 3, 4, 5, 6, 8, 9].includes(up)) return 'split';
    if (rank === 4 && (up === 5 || up === 6)) return 'split';
  }

  if (actions.includes('surrender') && !soft) {
    if (total === 16 && [9, 10, 11].includes(up)) return 'surrender';
    if (total === 15 && up === 10) return 'surrender';
  }

  if (soft) {
    if (total >= 19) return pick('stand');
    if (total === 18) {
      if ([3, 4, 5, 6].includes(up)) return pick('double', 'stand');
      if ([2, 7, 8].includes(up)) return pick('stand');
      return pick('hit');
    }
    if (total === 17 && [3, 4, 5, 6].includes(up)) return pick('double', 'hit');
    if ((total === 15 || total === 16) && [4, 5, 6].includes(up)) return pick('double', 'hit');
    if ((total === 13 || total === 14) && [5, 6].includes(up)) return pick('double', 'hit');
    return pick('hit');
  }

  if (total >= 17) return pick('stand');
  if (total >= 13) return up <= 6 ? pick('stand') : pick('hit');
  if (total === 12) return [4, 5, 6].includes(up) ? pick('stand') : pick('hit');
  if (total === 11) return pick('double', 'hit');
  if (total === 10) return up <= 9 ? pick('double', 'hit') : pick('hit');
  if (total === 9) return [3, 4, 5, 6].includes(up) ? pick('double', 'hit') : pick('hit');
  return pick('hit');
}
