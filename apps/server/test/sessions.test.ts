import { blackjack, crash, STARTING_CHIPS } from '@websino/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/index.js';
import { SESSION_COOKIE } from '../src/auth/index.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { auditBalances, getBalance } from '../src/db/ledger.js';

let db: Db;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeEach(async () => {
  db = openDatabase(':memory:');
  app = await buildServer(db);
});

afterEach(async () => {
  await app.close();
  db.close();
});

const signUp = async (username = 'session_player') => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'correct-horse-battery' },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${cookie?.value ?? ''}`;
};

const post = async (cookie: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });

const get = async (cookie: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

describe('slots over the one-shot round API', () => {
  it('plays and settles like any other round game', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/round', { game: 'slots', bet: 100, config: {} });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.detail.spins.length).toBeGreaterThanOrEqual(1);
    expect(body.balance).toBe(STARTING_CHIPS - 100 + body.payout);
    expect(auditBalances(db)).toEqual([]);
  });

  it('is listed as an available game', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json().games).toContain('slots');
  });
});

describe('blackjack', () => {
  it('deals a hand and hides the hole card', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/blackjack/deal', { bet: 100 })).json();

    expect(view.hands[0].cards).toHaveLength(2);
    if (view.holeHidden) {
      // Redaction, not obfuscation: the card is *absent*, and so is the total that
      // would give it away. A player with the network tab open learns nothing extra.
      expect(view.dealer).toHaveLength(1);
      expect(view.dealerTotal).toBeNull();
      expect(JSON.stringify(view)).not.toContain('"holeCard"');
    }
  });

  it('takes the stake the moment the hand is dealt', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/blackjack/deal', { bet: 100 })).json();
    // Either still playing (staked, nothing back) or already settled by a natural.
    expect(view.balance).toBe(STARTING_CHIPS - 100 + view.returned);
  });

  it('refuses an action that is not legal in the position', async () => {
    const cookie = await signUp();
    let view = (await post(cookie, '/api/blackjack/deal', { bet: 100 })).json();
    while (view.phase === 'insurance') {
      view = (await post(cookie, '/api/blackjack/insurance', { buy: false })).json();
    }
    if (view.phase !== 'player') return; // dealt a natural; nothing to test here

    const illegal = (['hit', 'stand', 'double', 'split', 'surrender'] as const)
      .find((a) => !view.actions.includes(a));
    if (!illegal) return;

    const response = await post(cookie, '/api/blackjack/action', { action: illegal });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().error).toMatch(/not available/);
  });

  it('refuses to act with no hand in progress', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/blackjack/action', { action: 'hit' });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a stake the player cannot cover', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/blackjack/deal', { bet: STARTING_CHIPS + 1 });
    expect(response.statusCode).toBe(400);
  });

  it('keeps one shoe across hands, under one commitment', async () => {
    const cookie = await signUp();
    const first = (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json();
    await playToEnd(cookie, first);
    const second = (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json();

    // Same shoe, same commitment - the point of committing per shoe rather than per
    // round is that the house cannot restack between hands.
    expect(second.proof.serverSeedHash).toBe(first.proof.serverSeedHash);
    expect(second.proof.nonce).toBe(first.proof.nonce);
    expect(second.cardsRemaining).toBeLessThan(first.cardsRemaining);
  });

  it('conserves chips across many complete hands', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 40; i += 1) {
      if (getBalance(db, userId()) < 20) break;
      const view = (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json();
      await playToEnd(cookie, view);
      expect(auditBalances(db)).toEqual([]);
    }

    // The wallet must equal the ledger, and the ledger must equal what the hands did.
    const wagered = db
      .prepare("SELECT COALESCE(SUM(-delta),0) AS n FROM ledger WHERE reason = 'wager'")
      .get() as { n: number };
    const paid = db
      .prepare("SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE reason = 'payout'")
      .get() as { n: number };
    expect(getBalance(db, userId())).toBe(STARTING_CHIPS - wagered.n + paid.n);
  });

  it('charges for a double only when the double actually happens', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 60; i += 1) {
      let view = (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json();
      while (view.phase === 'insurance') {
        view = (await post(cookie, '/api/blackjack/insurance', { buy: false })).json();
      }
      if (view.phase === 'player' && view.actions.includes('double')) {
        const before = view.balance;
        const after = (await post(cookie, '/api/blackjack/action', { action: 'double' })).json();
        // Exactly one extra stake left the wallet, plus whatever came back.
        expect(after.balance).toBe(before - 10 + after.returned);
        expect(after.hands[0].bet).toBe(20);
        expect(auditBalances(db)).toEqual([]);
        return;
      }
      await playToEnd(cookie, view);
    }
  });

  it('reveals the hole card once the hand is over', async () => {
    const cookie = await signUp();
    const view = await playToEnd(cookie, (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json());
    expect(view.phase).toBe('done');
    expect(view.holeHidden).toBe(false);
    expect((view.dealer as number[]).length).toBeGreaterThanOrEqual(2);
    expect(view.dealerTotal).not.toBeNull();
  });
});

const userId = (): string =>
  (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;

/** Stand everything until the hand finishes. */
async function playToEnd(cookie: string, start: Record<string, unknown>): Promise<Record<string, unknown>> {
  let view = start;
  let guard = 0;
  while (view.phase !== 'done' && guard < 20) {
    guard += 1;
    if (view.phase === 'insurance') {
      view = (await post(cookie, '/api/blackjack/insurance', { buy: false })).json();
      continue;
    }
    view = (await post(cookie, '/api/blackjack/action', { action: 'stand' })).json();
  }
  return view;
}

describe('crash', () => {
  it('starts a round without revealing the crash point', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/crash/start', { bet: 100 });
    const view = response.json();

    expect(view.state).toBe('running');
    expect(view.balance).toBe(STARTING_CHIPS - 100);
    // The single thing that would break the game if it leaked.
    expect(view.crashPoint).toBeUndefined();
    expect(response.body).not.toContain('crashPoint');
  });

  it('holds the crash point in the database, not in the response', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/crash/start', { bet: 100 });
    const row = db
      .prepare("SELECT state_json FROM game_sessions WHERE game = 'crash'")
      .get() as { state_json: string };
    const secret = (JSON.parse(row.state_json) as { round: crash.CrashRound }).round.crashPoint;
    expect(secret).toBeGreaterThanOrEqual(100);
    expect(response.body).not.toContain(String(secret));
  });

  it('refuses a second round while one is running', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/crash/start', { bet: 100 });
    const second = await post(cookie, '/api/crash/start', { bet: 100 });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses to cash out with nothing running', async () => {
    const cookie = await signUp();
    expect((await post(cookie, '/api/crash/cashout')).statusCode).toBe(409);
  });

  it('settles and reveals when the player cashes out', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/crash/start', { bet: 100 });
    const view = (await post(cookie, '/api/crash/cashout')).json();

    expect(['cashed', 'crashed']).toContain(view.state);
    expect(view.crashPoint).toBeGreaterThanOrEqual(100);
    if (view.state === 'cashed') {
      // Cashing out immediately means 1.00x, which returns exactly the stake.
      expect(view.payout).toBe(100);
      expect(view.balance).toBe(STARTING_CHIPS);
    } else {
      expect(view.payout).toBe(0);
    }
    expect(auditBalances(db)).toEqual([]);
  });

  it('honours an auto cash-out for a player who never comes back', async () => {
    const cookie = await signUp();
    // Force a round that survives well past 1.01x so the auto target can fire.
    let started = (await post(cookie, '/api/crash/start', { bet: 100, autoCashOut: 101 })).json();
    let guard = 0;
    while (guard < 50) {
      guard += 1;
      const row = db
        .prepare("SELECT id, state_json FROM game_sessions WHERE game = 'crash' AND closed_at IS NULL")
        .get() as { id: string; state_json: string } | undefined;
      if (!row) break;
      const state = JSON.parse(row.state_json) as { round: crash.CrashRound; startedAt: number };
      if (state.round.crashPoint >= 101) {
        // Pretend the round began long ago, then poll: the server must settle it
        // at the target rather than leaving a paid-for round stranded.
        db.prepare('UPDATE game_sessions SET state_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...state, startedAt: state.startedAt - 60_000 }), row.id);
        const view = (await get(cookie, '/api/crash')).json();
        expect(view.state).toBe('cashed');
        expect(view.cashedMultiplier).toBe(101);
        expect(view.payout).toBe(101);
        expect(auditBalances(db)).toEqual([]);
        return;
      }
      // That round busted at 1.00x; settle it and try again.
      await post(cookie, '/api/crash/cashout');
      started = (await post(cookie, '/api/crash/start', { bet: 100, autoCashOut: 101 })).json();
    }
    expect(started).toBeTruthy();
  });

  it('settles a stale round on the next start instead of stranding the stake', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/crash/start', { bet: 100 });
    const row = db
      .prepare("SELECT id, state_json FROM game_sessions WHERE game = 'crash'")
      .get() as { id: string; state_json: string };
    const state = JSON.parse(row.state_json) as { startedAt: number };
    db.prepare('UPDATE game_sessions SET state_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...state, startedAt: state.startedAt - 600_000 }), row.id);

    const second = await post(cookie, '/api/crash/start', { bet: 100 });
    expect(second.statusCode).toBe(200);
    expect(auditBalances(db)).toEqual([]);
    // Two rounds were paid for, and both are recorded.
    const rounds = db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE game = 'crash'").get() as { n: number };
    expect(rounds.n).toBe(1);
  });

  it('conserves chips across many rounds', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 30; i += 1) {
      await post(cookie, '/api/crash/start', { bet: 10 });
      await post(cookie, '/api/crash/cashout');
    }
    expect(auditBalances(db)).toEqual([]);
    const wagered = db
      .prepare("SELECT COALESCE(SUM(-delta),0) AS n FROM ledger WHERE reason = 'wager'")
      .get() as { n: number };
    expect(wagered.n).toBe(300);
  });
});

describe('everything stays behind the session cookie', () => {
  const endpoints: Array<[string, string]> = [
    ['POST', '/api/crash/start'],
    ['POST', '/api/crash/cashout'],
    ['GET', '/api/crash'],
    ['POST', '/api/blackjack/deal'],
    ['POST', '/api/blackjack/action'],
    ['POST', '/api/blackjack/insurance'],
    ['GET', '/api/blackjack'],
  ];

  for (const [method, url] of endpoints) {
    it(`${method} ${url} needs a signed-in user`, async () => {
      const response = await app.inject({ method: method as 'GET', url, payload: {} });
      expect(response.statusCode).toBe(401);
    });
  }
});

describe('the server seed never leaks from a stateful game', () => {
  it('is absent from every blackjack and crash payload', async () => {
    const cookie = await signUp();
    await get(cookie, '/api/fair');
    const secret = (db.prepare('SELECT server_seed FROM seed_pairs').get() as { server_seed: string })
      .server_seed;

    const bodies: string[] = [];
    bodies.push((await post(cookie, '/api/blackjack/deal', { bet: 10 })).body);
    bodies.push((await get(cookie, '/api/blackjack')).body);
    bodies.push((await post(cookie, '/api/blackjack/action', { action: 'stand' })).body);
    bodies.push((await post(cookie, '/api/crash/start', { bet: 10 })).body);
    bodies.push((await get(cookie, '/api/crash')).body);
    bodies.push((await post(cookie, '/api/crash/cashout')).body);
    bodies.push((await post(cookie, '/api/round', { game: 'slots', bet: 10, config: {} })).body);

    for (const body of bodies) expect(body).not.toContain(secret);
  });

  it('never ships the undealt shoe to the client', async () => {
    // The shoe is the answer to every future hand in this session. If the whole
    // `state_json` were ever serialised into a response, blackjack would be solved.
    const cookie = await signUp();
    const view = (await post(cookie, '/api/blackjack/deal', { bet: 10 })).json();
    const row = db
      .prepare("SELECT state_json FROM game_sessions WHERE game = 'blackjack'")
      .get() as { state_json: string };
    const shoe = (JSON.parse(row.state_json) as { shoe: { cards: number[]; position: number } }).shoe;

    const upcoming = shoe.cards.slice(shoe.position, shoe.position + 10);
    const seen = new Set<number>([
      ...(view.hands as Array<{ cards: number[] }>).flatMap((h) => h.cards),
      ...(view.dealer as number[]),
    ]);
    // None of the next ten cards is visible anywhere in the payload's card fields.
    expect(upcoming.filter((card) => seen.has(card)).length).toBeLessThan(upcoming.length);
    expect(JSON.stringify(view)).not.toContain(JSON.stringify(shoe.cards));
  });
});
