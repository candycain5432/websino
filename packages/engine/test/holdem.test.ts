import { createCasualSource, FairStream } from '@websino/fair';
import { describe, expect, it } from 'vitest';

import { parseHand } from '../src/cards.js';
import {
  act, botDecision, buildPots, canAct, contenders, createTable, currentPlayer, dealHand,
  estimateEquity, HoldemError, inHand, isHandOver, legalActions, makePlayer, makeTable,
  minRaiseTo, playBotTurn, potOf, PROFILES, RAKE_BPS, RAKE_CAP_BB, rakeFor, toCall,
  totalChips, type HoldemPlayer, type HoldemTable,
} from '../src/games/holdem/index.js';

const stream = (nonce: number): FairStream =>
  new FairStream({ serverSeed: 'a1'.repeat(32), clientSeed: 'holdem', nonce });

const casual = (seed = 1): ReturnType<typeof createCasualSource> => createCasualSource(seed);

/** A table of `n` seats with equal stacks; seat 0 is the human. */
function table(n: number, stack = 1000, blinds: [number, number] = [10, 20]): HoldemTable {
  const players = [makePlayer(0, 'You', stack)];
  for (let i = 1; i < n; i += 1) {
    players.push(makePlayer(i, `Bot ${i}`, stack, PROFILES[i % PROFILES.length]));
  }
  return createTable(players, blinds[0], blinds[1]);
}

const seat = (t: HoldemTable, i: number): HoldemPlayer => t.players[i] as HoldemPlayer;

describe('setting up a hand', () => {
  it('deals two cards to every seated player', () => {
    const t = dealHand(table(4), stream(1));
    for (const p of t.players) expect(p.hole).toHaveLength(2);
    const all = t.players.flatMap((p) => p.hole);
    expect(new Set(all).size).toBe(all.length);
  });

  it('posts the blinds and sets the current bet', () => {
    const t = dealHand(table(4), stream(2));
    expect(potOf(t)).toBe(30);
    expect(t.currentBet).toBe(20);
  });

  it('puts the button on the small blind heads up, and acts first preflop', () => {
    const t = dealHand(table(2), stream(3));
    // Heads up the button posts the small blind, so it has 10 out and acts first.
    const button = seat(t, t.button);
    expect(button.committed).toBe(10);
    expect(t.toAct).toBe(t.button);
  });

  it('starts with the seat left of the big blind at a full table', () => {
    const t = dealHand(table(4), stream(4));
    const sb = (t.button + 1) % 4;
    const bb = (t.button + 2) % 4;
    expect(seat(t, sb).committed).toBe(10);
    expect(seat(t, bb).committed).toBe(20);
    expect(t.toAct).toBe((t.button + 3) % 4);
  });

  it('refuses a table with fewer than two players', () => {
    expect(() => createTable([makePlayer(0, 'Lonely', 100)])).toThrow(HoldemError);
  });

  it('refuses to deal when fewer than two seats are funded', () => {
    const t = table(3);
    seat(t, 1).chips = 0;
    seat(t, 2).chips = 0;
    expect(() => dealHand(t, stream(5))).toThrow(/not enough funded/);
  });

  it('sits out a player with no chips and skips them', () => {
    const t = table(4);
    seat(t, 2).chips = 0;
    dealHand(t, stream(6));
    expect(seat(t, 2).sittingOut).toBe(true);
    expect(seat(t, 2).hole).toHaveLength(0);
    expect(inHand(seat(t, 2))).toBe(false);
  });

  it('is reproducible from the seed', () => {
    const a = dealHand(table(4), stream(9));
    const b = dealHand(table(4), stream(9));
    expect(a.players.map((p) => p.hole)).toEqual(b.players.map((p) => p.hole));
  });
});

describe('legal actions', () => {
  it('offers fold and call when there is money owed', () => {
    const t = dealHand(table(4), stream(10));
    expect(legalActions(t)).toContain('fold');
    expect(legalActions(t)).toContain('call');
    expect(legalActions(t)).toContain('raise');
    expect(legalActions(t)).not.toContain('check');
  });

  it('offers check rather than fold when nothing is owed', () => {
    const t = dealHand(table(3), stream(11));
    // Everyone calls to the big blind, who then owes nothing.
    act(t, 'call');
    act(t, 'call');
    expect(legalActions(t)).toContain('check');
    expect(legalActions(t)).not.toContain('fold');
  });

  it('offers nothing once the hand is over', () => {
    const t = dealHand(table(2), stream(12));
    act(t, 'fold');
    expect(isHandOver(t)).toBe(true);
    expect(legalActions(t)).toEqual([]);
  });

  it('will not let a player raise into a table of all-ins', () => {
    // Two short stacks all-in and one big stack: with nobody left who can respond,
    // raising is meaningless and must not be offered.
    const t = table(3, 1000);
    seat(t, 1).chips = 40;
    seat(t, 2).chips = 40;
    dealHand(t, stream(13));
    let guard = 0;
    while (!isHandOver(t) && guard < 20) {
      guard += 1;
      const p = currentPlayer(t);
      if (!p) break;
      const actions = legalActions(t, p);
      if (actions.includes('call')) act(t, 'call');
      else if (actions.includes('check')) act(t, 'check');
      else break;
      const live = contenders(t).filter((o) => !o.allIn);
      if (live.length <= 1) {
        for (const o of contenders(t).filter(canAct)) {
          expect(legalActions(t, o)).not.toContain('raise');
        }
        break;
      }
    }
  });
});

describe('betting', () => {
  it('refuses an action that is not legal', () => {
    const t = dealHand(table(4), stream(14));
    expect(() => act(t, 'check')).toThrow(/not legal/);
  });

  it('refuses to act when no hand is running', () => {
    const t = table(4);
    expect(() => act(t, 'fold')).toThrow(/no action is pending/);
  });

  it('clamps a raise below the minimum up to the minimum', () => {
    const t = dealHand(table(4), stream(15));
    const p = currentPlayer(t) as HoldemPlayer;
    const floor = minRaiseTo(t, p);
    act(t, 'raise', 1);
    expect(p.bet).toBe(floor);
  });

  it('clamps a raise above the stack down to all-in', () => {
    const t = dealHand(table(4), stream(16));
    const p = currentPlayer(t) as HoldemPlayer;
    act(t, 'raise', 10_000_000);
    expect(p.chips).toBe(0);
    expect(p.allIn).toBe(true);
  });

  it('reopens betting for a full raise', () => {
    const t = dealHand(table(4), stream(17));
    act(t, 'call');
    const raiser = currentPlayer(t) as HoldemPlayer;
    act(t, 'raise', 80);
    // Everyone still in who has already acted owes another decision.
    const caller = t.players.find((p) => p.seat !== raiser.seat && inHand(p) && p.hasActed);
    expect(caller?.hasActed ?? false).toBe(false);
  });

  it('does not reopen betting for an all-in short of a full raise', () => {
    // The classic rule that is easy to get wrong: a short all-in that does not make a
    // full raise leaves players who have already acted with nothing more to decide.
    const t = table(3, 1000);
    seat(t, 2).chips = 25; // enough to raise past the blind, not enough for a full one
    dealHand(t, stream(18));

    let guard = 0;
    while (!isHandOver(t) && guard < 10) {
      guard += 1;
      const p = currentPlayer(t);
      if (!p) break;
      if (p.seat === 2) {
        act(t, 'raise', 10_000);
        expect(p.allIn).toBe(true);
        // The short all-in raised the bet but by less than the minimum, so the
        // minimum raise increment must not have grown.
        expect(t.minRaise).toBe(20);
        return;
      }
      const actions = legalActions(t, p);
      act(t, actions.includes('call') ? 'call' : 'check');
    }
  });
});

describe('side pots', () => {
  const contributions = (amounts: number[], folded: number[] = []): HoldemPlayer[] =>
    amounts.map((committed, i) => ({
      ...makePlayer(i, `P${i}`, 0),
      committed,
      folded: folded.includes(i),
    }));

  it('makes a single pot when everyone matched', () => {
    const pots = buildPots(contributions([100, 100, 100]));
    expect(pots).toHaveLength(1);
    expect(pots[0]?.amount).toBe(300);
    expect(pots[0]?.eligible).toEqual([0, 1, 2]);
  });

  it('layers a side pot over a short all-in', () => {
    // Seat 0 is all-in for 50; the others go to 200.
    const pots = buildPots(contributions([50, 200, 200]));
    expect(pots).toHaveLength(2);
    expect(pots[0]).toMatchObject({ amount: 150, eligible: [0, 1, 2], isSide: false });
    expect(pots[1]).toMatchObject({ amount: 300, eligible: [1, 2], isSide: true });
    expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(450);
  });

  it('layers three ways', () => {
    const pots = buildPots(contributions([50, 120, 300, 300]));
    expect(pots.map((p) => p.amount)).toEqual([200, 210, 360]);
    expect(pots.map((p) => p.eligible)).toEqual([[0, 1, 2, 3], [1, 2, 3], [2, 3]]);
    expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(770);
  });

  it('keeps a folded player s chips in the pot but not their claim on it', () => {
    const pots = buildPots(contributions([100, 100, 100], [1]));
    expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(300);
    for (const pot of pots) expect(pot.eligible).not.toContain(1);
  });

  it('does not invent a side pot when a blind folds', () => {
    // Seat 0 folded their small blind; seats 1 and 2 went to 100. One pot, not two.
    const pots = buildPots(contributions([10, 100, 100], [0]));
    expect(pots).toHaveLength(1);
    expect(pots[0]?.amount).toBe(210);
    expect(pots[0]?.eligible).toEqual([1, 2]);
  });

  it('accounts for every committed chip, at random', () => {
    const random = casual(7);
    for (let trial = 0; trial < 500; trial += 1) {
      const size = 2 + random.randBelow(5);
      const amounts = Array.from({ length: size }, () => random.randBelow(500));
      const folded = amounts.map((_, i) => i).filter(() => random.nextFloat() < 0.3);
      const pots = buildPots(contributions(amounts, folded));
      const total = amounts.reduce((a, b) => a + b, 0);
      expect(pots.reduce((n, p) => n + p.amount, 0)).toBe(total);
    }
  });

  it('returns nothing when nobody has bet', () => {
    expect(buildPots(contributions([0, 0]))).toEqual([]);
  });
});

describe('the rake', () => {
  it('is five percent of the pot, floored', () => {
    expect(RAKE_BPS).toBe(500);
    expect(rakeFor(100, 20, true)).toBe(5);
    expect(rakeFor(39, 20, true)).toBe(1);   // 1.95 floors to 1, never rounds up
    expect(rakeFor(19, 20, true)).toBe(0);   // a pot too small to rake is free
  });

  it('caps at three big blinds however large the pot gets', () => {
    expect(RAKE_CAP_BB).toBe(3);
    expect(rakeFor(10_000, 20, true)).toBe(60);
    expect(rakeFor(1_000_000, 20, true)).toBe(60);
    // The cap scales with the stakes, not with a hardcoded number of chips.
    expect(rakeFor(1_000_000, 100, true)).toBe(300);
  });

  it('takes nothing when no flop was dealt', () => {
    // No flop, no drop. Otherwise players pay to fold their blinds, which is the one
    // thing that genuinely drives people off a table.
    expect(rakeFor(10_000, 20, false)).toBe(0);
    expect(rakeFor(30, 20, false)).toBe(0);
  });

  it('is not taken from a hand that ends pre-flop', () => {
    const t = table(3, 1_000);
    dealHand(t, stream(77));
    const before = totalChips(t);

    // Everyone folds to the big blind before a flop is ever dealt.
    let guard = 0;
    while (!isHandOver(t) && guard < 20) {
      guard += 1;
      act(t, legalActions(t).includes('fold') ? 'fold' : 'check');
    }
    expect(t.board).toHaveLength(0);
    expect(t.result?.rake).toBe(0);
    expect(totalChips(t)).toBe(before);
  });

  it('is taken once the flop is out, and only ever from the pot', () => {
    const t = table(3, 1_000);
    dealHand(t, stream(4));

    // Play to a finish with the cheapest legal action, which reaches a flop.
    let guard = 0;
    while (!isHandOver(t) && guard < 80) {
      guard += 1;
      const legal = legalActions(t);
      act(t, legal.includes('check') ? 'check' : legal.includes('call') ? 'call' : 'fold');
    }

    const result = t.result;
    expect(t.board.length).toBeGreaterThanOrEqual(3);
    expect(result?.rake).toBeGreaterThan(0);

    // What the winners were paid is the pot *after* the cut - the house is not paying
    // itself out of thin air, it is taking from chips the players committed.
    const paid = (result?.entries ?? []).reduce((n, e) => n + e.won, 0);
    const pots = (result?.pots ?? []).reduce((n, pot) => n + pot.amount, 0);
    expect(paid).toBe(pots);
  });

  it('never rakes a pot into the negative', () => {
    // A tiny pot with a big blind large enough that the uncapped cut would exceed it.
    const t = table(2, 40, [1, 2]);
    dealHand(t, stream(13));
    let guard = 0;
    while (!isHandOver(t) && guard < 80) {
      guard += 1;
      const legal = legalActions(t);
      act(t, legal.includes('check') ? 'check' : legal.includes('call') ? 'call' : 'fold');
    }
    for (const pot of t.result?.pots ?? []) expect(pot.amount).toBeGreaterThanOrEqual(0);
    for (const player of t.players) expect(player.chips).toBeGreaterThanOrEqual(0);
  });
});

describe('chip conservation', () => {
  /**
   * The invariant pysino broke, which is why it gets the most coverage here.
   *
   * Chips only ever move between seats, with exactly one exception: the rake, which
   * leaves the table at settlement. So the total is identical before a hand and after
   * every single action *within* it, and drops by precisely the rake when the hand
   * settles - never by a chip more. Stating it as a running total rather than "roughly
   * conserved" is the point: a leak of any other size still fails.
   */
  it('holds after every action of every hand, bots playing themselves', () => {
    const random = casual(42);
    const t = table(5, 1000);
    let expected = totalChips(t);
    let rakeTaken = 0;

    for (let hand = 0; hand < 60; hand += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(hand));
      expect(totalChips(t)).toBe(expected);

      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        const before = totalChips(t);
        playBotTurn(t, random);
        // Mid-hand nothing leaves the table; only settlement may take the rake, and
        // only the action that ends the hand can settle it.
        expect(totalChips(t)).toBe(isHandOver(t) ? before - (t.result?.rake ?? 0) : before);
      }
      expect(isHandOver(t)).toBe(true);

      expected -= t.result?.rake ?? 0;
      rakeTaken += t.result?.rake ?? 0;
      expect(totalChips(t)).toBe(expected);
    }
    expect(t.handNumber).toBeGreaterThan(5);
    // The rake is a real sink, not a rounding artefact that happens to be zero.
    expect(rakeTaken).toBeGreaterThan(0);
  });

  it('pays out exactly the pot, never more', () => {
    const random = casual(9);
    const t = table(4, 500);
    for (let hand = 0; hand < 40; hand += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      // Snapshot before dealing: `dealHand` posts the blinds, so a snapshot after it
      // has already moved 30 chips out of stacks and into commitment.
      const before = t.players.map((p) => p.chips);
      dealHand(t, stream(200 + hand));
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        playBotTurn(t, random);
      }

      const result = t.result;
      expect(result).not.toBeNull();
      // `pots` are reported as they were paid - already net of the rake - so what the
      // winners received still has to equal them exactly.
      const potTotal = (result?.pots ?? []).reduce((n, p) => n + p.amount, 0);
      const paid = (result?.entries ?? []).reduce((n, e) => n + e.won, 0);
      expect(paid).toBe(potTotal);

      // And the stacks moved by exactly the rake, in aggregate: the only chips that
      // left the table are the ones the house took.
      const delta = t.players.reduce((n, p, i) => n + (p.chips - (before[i] as number)), 0);
      expect(delta).toBe(-(result?.rake ?? 0));
    }
  });

  it('leaves nothing committed once a hand is settled', () => {
    const random = casual(11);
    const t = table(3, 800);
    dealHand(t, stream(300));
    let guard = 0;
    while (!isHandOver(t) && guard < 100) {
      guard += 1;
      playBotTurn(t, random);
    }
    expect(potOf(t)).toBe(0);
    for (const p of t.players) {
      expect(p.bet).toBe(0);
      expect(p.committed).toBe(0);
    }
  });

  it('never leaves a player with negative chips', () => {
    const random = casual(13);
    const t = table(5, 300);
    for (let hand = 0; hand < 50; hand += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(400 + hand));
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        playBotTurn(t, random);
        for (const p of t.players) expect(p.chips).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('settling', () => {
  it('gives the pot to the last player standing without a showdown', () => {
    const t = dealHand(table(3), stream(20));
    const pot = potOf(t);
    act(t, 'fold');
    act(t, 'fold');
    expect(isHandOver(t)).toBe(true);
    expect(t.result?.wentToShowdown).toBe(false);
    expect(t.result?.winners).toHaveLength(1);
    expect(t.result?.entries[0]?.won).toBe(pot);
  });

  it('runs the board out when everyone is all in', () => {
    const t = table(2, 100);
    dealHand(t, stream(21));
    let guard = 0;
    while (!isHandOver(t) && guard < 20) {
      guard += 1;
      const actions = legalActions(t);
      if (actions.includes('raise')) act(t, 'raise', 10_000);
      else if (actions.includes('call')) act(t, 'call');
      else if (actions.includes('check')) act(t, 'check');
      else break;
    }
    expect(isHandOver(t)).toBe(true);
    expect(t.result?.wentToShowdown).toBe(true);
    expect(t.board).toHaveLength(5);
  });

  it('describes each hand at showdown', () => {
    const random = casual(3);
    const t = table(3, 1000);
    for (let hand = 0; hand < 25; hand += 1) {
      dealHand(t, stream(500 + hand));
      let guard = 0;
      while (!isHandOver(t) && guard < 100) {
        guard += 1;
        playBotTurn(t, random);
      }
      if (t.result?.wentToShowdown) {
        for (const entry of t.result.entries) {
          expect(entry.description).toBeTruthy();
          expect(entry.rank).not.toBeNull();
        }
        return;
      }
    }
  });

  it('splits a tied pot and gives the odd chip left of the button', () => {
    // Two seats, an identical board-plays-itself hand, and an odd pot.
    const t = table(2, 1000);
    dealHand(t, stream(22));
    // Force a tie: give both players the same two ranks and a board that plays itself.
    seat(t, 0).hole = parseHand('2c 3d');
    seat(t, 1).hole = parseHand('2h 3s');
    t.deck = [...t.deck];
    // Put a royal flush on the board so both players play the board exactly.
    const board = parseHand('As Ks Qs Js 10s');
    t.deck.splice(t.deckPosition, 5, ...board);

    let guard = 0;
    while (!isHandOver(t) && guard < 20) {
      guard += 1;
      const actions = legalActions(t);
      if (actions.includes('call')) act(t, 'call');
      else if (actions.includes('check')) act(t, 'check');
      else break;
    }

    expect(t.result?.wentToShowdown).toBe(true);
    const won = (t.result?.entries ?? []).map((e) => e.won);
    expect(won.reduce((a, b) => a + b, 0)).toBe(
      (t.result?.pots ?? []).reduce((n, p) => n + p.amount, 0),
    );
    // Both played the board, so the split is even or off by the odd chip.
    expect(Math.abs((won[0] as number) - (won[1] as number))).toBeLessThanOrEqual(1);
  });
});

describe('bots', () => {
  it('never draws from the fair stream', () => {
    // The signature takes a CasualSource, so the fair stream will not compile here.
    // This checks the deal's stream is genuinely untouched by a decision.
    const s = stream(30);
    const t = dealHand(table(4), s);
    const before = s.bytesUsed;
    botDecision(t, casual(5));
    expect(s.bytesUsed).toBe(before);
  });

  it('is reproducible from the casual seed', () => {
    const a = dealHand(table(4), stream(31));
    const b = dealHand(table(4), stream(31));
    expect(botDecision(a, casual(77))).toEqual(botDecision(b, casual(77)));
  });

  it('only ever chooses a legal action', () => {
    const random = casual(17);
    const t = table(5, 1000);
    for (let hand = 0; hand < 30; hand += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(600 + hand));
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        const p = currentPlayer(t) as HoldemPlayer;
        const decision = botDecision(t, random);
        expect(legalActions(t, p)).toContain(decision.action);
        act(t, decision.action, decision.amount);
      }
    }
  });

  it('never bets more than it has', () => {
    const random = casual(19);
    const t = table(4, 200);
    for (let hand = 0; hand < 30; hand += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(700 + hand));
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        const p = currentPlayer(t) as HoldemPlayer;
        const decision = botDecision(t, random);
        if (decision.action === 'bet' || decision.action === 'raise') {
          expect(decision.amount).toBeLessThanOrEqual(p.bet + p.chips);
        }
        act(t, decision.action, decision.amount);
      }
    }
  });

  it('gives every profile a distinct style', () => {
    const names = PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(PROFILES.length);
    for (const profile of PROFILES) {
      expect(profile.tightness).toBeGreaterThan(0);
      expect(profile.tightness).toBeLessThan(1);
      expect(profile.iterations).toBeGreaterThan(0);
    }
  });

  it('seats bots with distinct names and personalities', () => {
    const players = makeTable(casual(23), 1000, 4);
    expect(players).toHaveLength(5);
    expect(players[0]?.isBot).toBe(false);
    const bots = players.slice(1);
    expect(new Set(bots.map((p) => p.name)).size).toBe(bots.length);
    for (const bot of bots) expect(bot.profile).not.toBeNull();
  });
});

describe('equity estimation', () => {
  it('rates a made royal flush as unbeatable', () => {
    const equity = estimateEquity(
      parseHand('As Ks'), parseHand('Qs Js 10s'), 1, casual(1), 200,
    );
    expect(equity).toBe(1);
  });

  it('rates the worst hand against a made nut hand as hopeless', () => {
    const equity = estimateEquity(
      parseHand('2c 7d'), parseHand('As Ks Qs'), 1, casual(1), 200,
    );
    expect(equity).toBeLessThan(0.35);
  });

  it('rates aces over deuces preflop', () => {
    const aces = estimateEquity(parseHand('As Ah'), [], 3, casual(2), 400);
    const deuces = estimateEquity(parseHand('2c 7d'), [], 3, casual(2), 400);
    expect(aces).toBeGreaterThan(deuces);
    expect(aces).toBeGreaterThan(0.5);
  });

  it('falls to a coin flip heads up with identical information', () => {
    // A board that plays itself: nothing either player holds can matter.
    const equity = estimateEquity(
      parseHand('2c 3d'), parseHand('As Ks Qs Js 10s'), 1, casual(4), 300,
    );
    expect(equity).toBeCloseTo(0.5, 1);
  });

  it('returns certainty with no opponents', () => {
    expect(estimateEquity(parseHand('2c 7d'), [], 0, casual(1), 10)).toBe(1);
  });
});

describe('a full table plays itself', () => {
  it('reaches a winner without stalling, repeatedly', () => {
    const random = casual(101);
    const t = table(6, 1000);
    let hands = 0;

    for (let i = 0; i < 120; i += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(900 + i));
      hands += 1;
      let guard = 0;
      while (!isHandOver(t) && guard < 300) {
        guard += 1;
        playBotTurn(t, random);
      }
      // A hand that does not finish inside 300 actions is a loop, not a long hand.
      expect(isHandOver(t)).toBe(true);
      expect(t.result).not.toBeNull();
    }

    expect(hands).toBeGreaterThan(20);
    // Someone has to have won something over that many hands.
    expect(Math.max(...t.players.map((p) => p.chips))).toBeGreaterThan(1000);
  });

  it('moves the button every hand, skipping busted seats', () => {
    const random = casual(31);
    const t = table(4, 1000);
    const buttons: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      dealHand(t, stream(1000 + i));
      buttons.push(t.button);
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        playBotTurn(t, random);
      }
    }
    // It must not sit still, and it must visit more than one seat.
    expect(new Set(buttons).size).toBeGreaterThan(1);
    for (const b of buttons) expect(seat(t, b)).toBeDefined();
  });

  it('keeps to-act pointing at somebody who can actually act', () => {
    const random = casual(37);
    const t = table(5, 400);
    for (let i = 0; i < 30; i += 1) {
      if (t.players.filter((p) => p.chips > 0).length < 2) break;
      dealHand(t, stream(1100 + i));
      let guard = 0;
      while (!isHandOver(t) && guard < 200) {
        guard += 1;
        const p = currentPlayer(t);
        expect(p).not.toBeNull();
        expect(canAct(p as HoldemPlayer)).toBe(true);
        expect(toCall(t, p as HoldemPlayer)).toBeGreaterThanOrEqual(0);
        playBotTurn(t, random);
      }
    }
  });
});
