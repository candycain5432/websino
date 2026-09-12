import { describe, expect, it } from 'vitest';

import { FairStream } from '@websino/fair';
import { type Card, parseHand } from '../src/cards.js';
import { shuffleShoe, type ShoeState } from '../src/shoe.js';
import {
  act, availableActions, basicStrategy, canSplit, dealerHasBlackjack, deal, DEFAULT_RULES,
  handLabel, handValue, isBlackjack, isBusted, takeInsurance,
  type BlackjackRound, type Rules,
} from '../src/games/blackjack/index.js';

const takeIt = takeInsurance;

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'b'.repeat(64), clientSeed: 'blackjack', nonce });

/** A shoe that deals exactly the cards named, in order. */
function stackedShoe(text: string): ShoeState {
  const cards = parseHand(text);
  return { cards, position: 0, cutCard: cards.length, decks: 1 };
}

/**
 * Deal from a stack. The deal order is player, dealer, player, dealer - so
 * `"Ah 7s Kd 9c"` gives the player A-K and the dealer 7-9.
 */
const dealFrom = (text: string, bet = 100, rules: Rules = DEFAULT_RULES): BlackjackRound =>
  deal(stackedShoe(text), bet, rules);

describe('hand value', () => {
  it('counts an ace as eleven until it has to shrink', () => {
    expect(handValue(parseHand('Ah 9s'))).toEqual([20, true]);
    expect(handValue(parseHand('Ah 9s 5d'))).toEqual([15, false]);
  });

  it('shrinks only as many aces as it must', () => {
    expect(handValue(parseHand('Ah As'))).toEqual([12, true]);
    expect(handValue(parseHand('Ah As 9d'))).toEqual([21, true]);
    expect(handValue(parseHand('Ah As As Ad'))).toEqual([14, true]);
  });

  it('counts every face card as ten', () => {
    expect(handValue(parseHand('Jh Qs'))[0]).toBe(20);
    expect(handValue(parseHand('Kh 10s'))[0]).toBe(20);
  });

  it('labels hands the way a table would', () => {
    expect(handLabel({ ...blank, cards: parseHand('Ah Ks') })).toBe('Blackjack');
    expect(handLabel({ ...blank, cards: parseHand('Kh Qs 5d') })).toBe('Bust (25)');
    expect(handLabel({ ...blank, cards: parseHand('Ah 6s') })).toBe('7/17');
    expect(handLabel({ ...blank, cards: parseHand('9h 8s') })).toBe('17');
  });
});

const blank = {
  cards: [] as Card[], bet: 100, doubled: false, fromSplit: false, splitAces: false,
  stood: false, surrendered: false, outcome: null, payout: 0,
};

describe('naturals', () => {
  it('pays a blackjack 3:2 and ends the round at once', () => {
    const round = dealFrom('Ah 7s Kd 9c');
    expect(round.phase).toBe('done');
    expect(round.hands[0]?.outcome).toBe('blackjack');
    expect(round.returned).toBe(250); // 100 back + 150 won
  });

  it('pushes blackjack against blackjack', () => {
    const round = dealFrom('Ah Ks Kd Ac');
    expect(round.phase).toBe('done');
    expect(dealerHasBlackjack(round)).toBe(true);
    expect(round.hands[0]?.outcome).toBe('push');
    expect(round.returned).toBe(100);
  });

  it('floors an odd blackjack payout in the house s favour', () => {
    const round = dealFrom('Ah 7s Kd 9c', 25);
    // 25 * 1.5 = 37.5, so 37 - never 38.
    expect(round.returned).toBe(25 + 37);
  });
});

describe('insurance', () => {
  it('is offered only against an ace', () => {
    expect(dealFrom('Kh 7s 5d Ac').phase).not.toBe('insurance');
    expect(dealFrom('Kh As 5d 9c').phase).toBe('insurance');
  });

  it('pays 2:1 when the dealer really has it', () => {
    const round = takeIt(dealFrom('Kh As 5d Kc'), true);
    expect(round.insuranceBet).toBe(50);
    expect(round.insurancePayout).toBe(150);
    // The main bet loses to the dealer's blackjack, insurance covers it exactly.
    expect(round.hands[0]?.outcome).toBe('lose');
    expect(round.returned).toBe(150);
    expect(round.staked).toBe(150);
  });

  it('costs half the bet and is lost when the dealer has nothing', () => {
    const round = takeIt(dealFrom('Kh As 5d 4c'), true);
    expect(round.staked).toBe(150);
    expect(round.insurancePayout).toBe(0);
  });

  it('can be declined without cost', () => {
    const round = takeIt(dealFrom('Kh As 5d 4c'), false);
    expect(round.insuranceBet).toBe(0);
    expect(round.staked).toBe(100);
  });
});

describe('player actions', () => {
  it('offers double and surrender only on the first two cards', () => {
    const shoe = stackedShoe('5h 7s 6d 9c 4h 3s');
    const round = deal(shoe, 100);
    expect(availableActions(round)).toContain('double');
    expect(availableActions(round)).toContain('surrender');

    const hit = act(round, 'hit', shoe);
    expect(availableActions(hit)).not.toContain('double');
    expect(availableActions(hit)).not.toContain('surrender');
  });

  it('returns half the bet on surrender', () => {
    const shoe = stackedShoe('Kh 7s 6d 9c');
    const round = act(deal(shoe, 100), 'surrender', shoe);
    expect(round.phase).toBe('done');
    expect(round.hands[0]?.outcome).toBe('surrender');
    expect(round.returned).toBe(50);
  });

  it('doubles the wager and takes exactly one card', () => {
    const shoe = stackedShoe('5h 7s 6d 9c 9h 5d 8c');
    const round = act(deal(shoe, 100), 'double', shoe);
    expect(round.hands[0]?.bet).toBe(200);
    expect(round.hands[0]?.cards).toHaveLength(3);
    expect(round.staked).toBe(200);
    expect(round.phase).toBe('done');
  });

  it('refuses an action that is not on offer', () => {
    const shoe = stackedShoe('Kh 7s 6d 9c');
    const round = deal(shoe, 100);
    expect(() => act(round, 'split', shoe)).toThrow(/not available/);
  });

  it('refuses to act once the round is over', () => {
    const shoe = stackedShoe('Ah 7s Kd 9c');
    const round = deal(shoe, 100);
    expect(() => act(round, 'hit', shoe)).toThrow(/cannot act/);
  });

  it('busts and moves on', () => {
    const shoe = stackedShoe('Kh 7s 6d 9c Qh');
    const round = act(deal(shoe, 100), 'hit', shoe);
    expect(isBusted(round.hands[0] as never)).toBe(true);
    expect(round.phase).toBe('done');
    expect(round.returned).toBe(0);
  });
});

describe('splitting', () => {
  it('splits a pair into two funded hands', () => {
    const shoe = stackedShoe('8h 7s 8d 9c 3h 4s');
    const round = act(deal(shoe, 100), 'split', shoe);
    expect(round.hands).toHaveLength(2);
    expect(round.staked).toBe(200);
    expect(round.hands[0]?.cards).toHaveLength(2);
    expect(round.hands[1]?.cards).toHaveLength(2);
  });

  it('splits on rank value, so a king and a queen are a pair', () => {
    expect(canSplit({ ...blank, cards: parseHand('Kh Qs') })).toBe(true);
    expect(canSplit({ ...blank, cards: parseHand('Kh 9s') })).toBe(false);
  });

  it('gives split aces one card each and stops', () => {
    const shoe = stackedShoe('Ah 7s Ad 9c 3h 4s 5d 8c');
    const round = act(deal(shoe, 100), 'split', shoe);
    expect(round.phase).toBe('done');
    for (const hand of round.hands) expect(hand.cards).toHaveLength(2);
  });

  it('never calls a split hand a blackjack', () => {
    const shoe = stackedShoe('Ah 7s Ad 9c Kh Qs 5d 8c');
    const round = act(deal(shoe, 100), 'split', shoe);
    for (const hand of round.hands) {
      expect(handValue(hand.cards)[0]).toBe(21);
      expect(isBlackjack(hand)).toBe(false);
      // 21 on a split hand pays even money, not 3:2.
      expect(hand.outcome === 'win' ? hand.payout : 200).toBe(200);
    }
  });

  it('stops at the table s hand limit', () => {
    const shoe = stackedShoe('8h 7s 8d 9c 8s 8c 2h 3s 4d 5c 6h 7d 9h 10s Jd Qc Kh 2d');
    let round = deal(shoe, 100);
    let splits = 0;
    while (availableActions(round).includes('split') && splits < 10) {
      round = act(round, 'split', shoe);
      splits += 1;
    }
    expect(round.hands.length).toBeLessThanOrEqual(DEFAULT_RULES.maxHands);
  });
});

describe('the dealer', () => {
  it('stands on soft 17 under the default rules', () => {
    const shoe = stackedShoe('Kh 6d 9s Ah 2h');
    const round = act(deal(shoe, 100), 'stand', shoe);
    expect(handValue(round.dealer)).toEqual([17, true]);
    expect(round.dealer).toHaveLength(2);
  });

  it('hits soft 17 when the rules say so', () => {
    const shoe = stackedShoe('Kh 6d 9s Ah 2h 7c');
    const rules = { ...DEFAULT_RULES, dealerHitsSoft17: true };
    const round = act(deal(shoe, 100, rules), 'stand', shoe);
    expect(round.dealer.length).toBeGreaterThan(2);
  });

  it('does not draw against a table of busted hands', () => {
    // Every player hand is dead, so the dealer has nothing to beat and must not burn
    // cards the player is entitled to verify.
    const shoe = stackedShoe('Kh 5s 6d 2c Qh');
    const round = act(deal(shoe, 100), 'hit', shoe);
    expect(isBusted(round.hands[0] as never)).toBe(true);
    expect(round.dealer).toHaveLength(2);
  });

  it('reveals the hole card once play passes to it', () => {
    const shoe = stackedShoe('Kh 7s 9d 9c 5h');
    expect(deal(stackedShoe('Kh 7s 9d 9c 5h'), 100).holeHidden).toBe(true);
    expect(act(deal(shoe, 100), 'stand', shoe).holeHidden).toBe(false);
  });
});

describe('settlement', () => {
  const cases: Array<[string, string, number]> = [
    ['player 20 beats dealer 19', 'Kh 9s Qd 10c', 200],
    ['player 19 loses to dealer 20', '10h Kd 9s Qc', 0],
    ['equal totals push', 'Kh Ks 9d 9c', 100],
    ['dealer bust pays', '9h 6s 8d 9c', 200],
  ];

  for (const [name, stack, expected] of cases) {
    it(name, () => {
      const shoe = stackedShoe(`${stack} Kh`);
      const round = act(deal(shoe, 100), 'stand', shoe);
      expect(round.returned).toBe(expected);
    });
  }
});

describe('basic strategy', () => {
  it('always splits aces and eights', () => {
    const round = dealFrom('8h 7s 8d 9c');
    const hand = round.hands[0] as never;
    expect(basicStrategy(hand, parseHand('9c')[0] as Card, availableActions(round))).toBe('split');
  });

  it('never splits tens', () => {
    const round = dealFrom('Kh 7s Qd 9c');
    const hand = round.hands[0] as never;
    expect(basicStrategy(hand, parseHand('7s')[0] as Card, availableActions(round))).not.toBe('split');
  });

  it('doubles eleven against a small card', () => {
    const round = dealFrom('6h 7s 5d 9c');
    const hand = round.hands[0] as never;
    expect(basicStrategy(hand, parseHand('7s')[0] as Card, availableActions(round))).toBe('double');
  });

  it('stands on hard 17 or better', () => {
    const round = dealFrom('Kh 7s 7d 9c');
    const hand = round.hands[0] as never;
    expect(basicStrategy(hand, parseHand('7s')[0] as Card, availableActions(round))).toBe('stand');
  });

  it('surrenders 16 against a ten', () => {
    const round = dealFrom('Kh 10s 6d 9c');
    const hand = round.hands[0] as never;
    expect(basicStrategy(hand, parseHand('10s')[0] as Card, availableActions(round))).toBe('surrender');
  });

  it('only ever advises a legal action', () => {
    // The advice has to be restricted to what is actually on offer, or the hint button
    // suggests moves the table will refuse.
    for (let nonce = 0; nonce < 400; nonce += 1) {
      const shoe = shuffleShoe(stream(nonce), 1);
      let round = deal(shoe, 100);
      while (round.phase === 'player') {
        const actions = availableActions(round);
        const up = round.dealer[0] as Card;
        const advice = basicStrategy(round.hands[round.activeIndex] as never, up, actions);
        expect(actions).toContain(advice);
        round = act(round, advice, shoe);
      }
    }
  });
});

describe('chip conservation', () => {
  it('never returns more than the table could owe', () => {
    // pysino minted 4,918 chips from a bad hold'em refund. The equivalent here would be
    // a settlement that pays out more than the maximum the rules allow.
    for (let nonce = 0; nonce < 2000; nonce += 1) {
      const shoe = shuffleShoe(stream(nonce), 6);
      let round = deal(shoe, 100);
      while (round.phase === 'insurance' || round.phase === 'player') {
        if (round.phase === 'insurance') {
          round = takeIt(round, nonce % 2 === 0);
          continue;
        }
        const actions = availableActions(round);
        const up = round.dealer[0] as Card;
        round = act(round, basicStrategy(round.hands[round.activeIndex] as never, up, actions), shoe);
      }
      expect(round.phase).toBe('done');
      expect(round.returned).toBeGreaterThanOrEqual(0);
      // The best possible outcome is every hand a blackjack plus insurance paid.
      expect(round.returned).toBeLessThanOrEqual(round.staked * 3);
      expect(Number.isInteger(round.returned)).toBe(true);
    }
  });

  it('lands within noise of the theoretical house edge', () => {
    // ~0.5% for these rules. Basic strategy, flat bets, one shoe per round.
    let staked = 0;
    let returned = 0;
    const rounds = 25_000;
    for (let nonce = 0; nonce < rounds; nonce += 1) {
      const shoe = shuffleShoe(stream(nonce), 6);
      let round = deal(shoe, 100);
      while (round.phase === 'insurance' || round.phase === 'player') {
        if (round.phase === 'insurance') {
          // Basic strategy never takes insurance.
          round = takeIt(round, false);
          continue;
        }
        const actions = availableActions(round);
        const up = round.dealer[0] as Card;
        round = act(round, basicStrategy(round.hands[round.activeIndex] as never, up, actions), shoe);
      }
      staked += round.staked;
      returned += round.returned;
    }
    const edge = 1 - returned / staked;
    expect(edge).toBeGreaterThan(-0.01);
    expect(edge).toBeLessThan(0.025);
  });
});

describe('the shoe', () => {
  it('shuffles every card exactly once', () => {
    const shoe = shuffleShoe(stream(1), 6);
    expect(shoe.cards).toHaveLength(312);
    const counts = new Map<number, number>();
    for (const card of shoe.cards) counts.set(card, (counts.get(card) ?? 0) + 1);
    expect(counts.size).toBe(52);
    for (const n of counts.values()) expect(n).toBe(6);
  });

  it('puts the cut card at the stated penetration', () => {
    expect(shuffleShoe(stream(1), 6, 0.75).cutCard).toBe(234);
  });

  it('is reproducible from the seed, so a whole shoe is verifiable', () => {
    expect(shuffleShoe(stream(5), 6).cards).toEqual(shuffleShoe(stream(5), 6).cards);
  });

  it('differs between seeds', () => {
    expect(shuffleShoe(stream(5), 6).cards).not.toEqual(shuffleShoe(stream(6), 6).cards);
  });
});
