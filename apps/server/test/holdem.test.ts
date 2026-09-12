import { STARTING_CHIPS } from '@websino/engine';
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

const signUp = async (username = 'poker_player') => {
  const response = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { username, password: 'correct-horse-battery' },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${cookie?.value ?? ''}`;
};

const post = async (cookie: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });

const get = async (cookie: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

const userId = (): string =>
  (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;

/** Play the human's turns cheaply until the hand is over. */
async function finishHand(cookie: string, view: Record<string, unknown>): Promise<Record<string, unknown>> {
  let current = view;
  let guard = 0;
  while (current.handInProgress && guard < 30) {
    guard += 1;
    if (!current.yourTurn) break;
    const actions = current.actions as string[];
    const action = actions.includes('check') ? 'check' : 'fold';
    current = (await post(cookie, '/api/holdem/act', { action, amount: 0 })).json();
  }
  return current;
}

describe('sitting down', () => {
  it('debits the buy-in and seats three bots', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();

    expect(view.seats).toHaveLength(4);
    expect(view.seats[0].isBot).toBe(false);
    expect(view.balance).toBe(STARTING_CHIPS - 500);
    expect(auditBalances(db)).toEqual([]);
  });

  it('gives every bot a name and a style', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();
    const bots = (view.seats as Array<Record<string, unknown>>).slice(1);
    for (const bot of bots) {
      expect(bot.name).toBeTruthy();
      expect(bot.style).toBeTruthy();
    }
    expect(new Set(bots.map((b) => b.name)).size).toBe(bots.length);
  });

  it('refuses a buy-in the player cannot cover', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/holdem/sit', { buyIn: STARTING_CHIPS + 1 });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to sit at two tables', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/holdem/sit', { buyIn: 200 });
    expect((await post(cookie, '/api/holdem/sit', { buyIn: 200 })).statusCode).toBe(409);
  });

  it('deals the first hand immediately', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();
    expect(view.handNumber).toBe(1);
    expect(view.pot).toBeGreaterThan(0);
  });
});

describe('the bots hole cards stay hidden', () => {
  it('are absent from the payload while the hand is live', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/holdem/sit', { buyIn: 500 });
    const view = response.json();

    // Your own cards are yours to see.
    expect(view.seats[0].hole).toHaveLength(2);
    for (const seat of (view.seats as Array<Record<string, unknown>>).slice(1)) {
      if (view.handInProgress) expect(seat.hole).toBeUndefined();
    }
  });

  it('never ships the undealt deck', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/holdem/sit', { buyIn: 500 });
    const row = db
      .prepare("SELECT state_json FROM game_sessions WHERE game = 'holdem'")
      .get() as { state_json: string };
    const deck = (JSON.parse(row.state_json) as { table: { deck: number[] } }).table.deck;

    expect(deck).toHaveLength(52);
    expect(response.body).not.toContain(JSON.stringify(deck));
  });

  it('shows them at a showdown', async () => {
    const cookie = await signUp();
    // Call everything down until a hand reaches a showdown.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let view = attempt === 0
        ? (await post(cookie, '/api/holdem/sit', { buyIn: 900 })).json()
        : (await post(cookie, '/api/holdem/deal')).json();

      let guard = 0;
      while (view.handInProgress && view.yourTurn && guard < 30) {
        guard += 1;
        const actions = view.actions as string[];
        const action = actions.includes('check') ? 'check' : actions.includes('call') ? 'call' : 'fold';
        view = (await post(cookie, '/api/holdem/act', { action, amount: 0 })).json();
      }

      if (view.result?.wentToShowdown) {
        const shown = (view.seats as Array<Record<string, unknown>>)
          .filter((s) => !s.folded && !s.sittingOut);
        for (const seat of shown) expect(seat.hole).toHaveLength(2);
        return;
      }
      if (getBalance(db, userId()) < 50 && !view.handInProgress) break;
    }
  });
});

describe('playing', () => {
  it('refuses to act out of turn', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();
    if (!view.yourTurn) {
      expect((await post(cookie, '/api/holdem/act', { action: 'fold' })).statusCode).toBe(409);
    }
  });

  it('refuses an action the rules do not allow', async () => {
    const cookie = await signUp();
    let view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();
    if (!view.yourTurn) return;
    const illegal = ['fold', 'check', 'call', 'bet', 'raise']
      .find((a) => !(view.actions as string[]).includes(a));
    if (!illegal) return;
    const response = await post(cookie, '/api/holdem/act', { action: illegal, amount: 0 });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to deal while a hand is running', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 500 })).json();
    if (view.handInProgress) {
      expect((await post(cookie, '/api/holdem/deal')).statusCode).toBe(409);
    }
  });

  it('takes a fresh nonce for every hand, so each is verifiable alone', async () => {
    const cookie = await signUp();
    const first = (await post(cookie, '/api/holdem/sit', { buyIn: 900 })).json();
    await finishHand(cookie, first);
    const second = (await post(cookie, '/api/holdem/deal')).json();
    expect(second.proof.nonce).toBeGreaterThan(first.proof.nonce);
  });

  it('refuses to act with no table', async () => {
    const cookie = await signUp();
    expect((await post(cookie, '/api/holdem/act', { action: 'fold' })).statusCode).toBe(409);
  });
});

describe('standing up', () => {
  it('returns the stack and closes the table', async () => {
    const cookie = await signUp();
    const view = await finishHand(cookie, (await post(cookie, '/api/holdem/sit', { buyIn: 400 })).json());
    const stack = (view.seats as Array<{ chips: number }>)[0]?.chips ?? 0;

    const left = (await post(cookie, '/api/holdem/leave')).json();
    expect(left.cashedOut).toBe(stack);
    expect(left.balance).toBe(STARTING_CHIPS - 400 + stack);
    expect(auditBalances(db)).toEqual([]);
    expect((await get(cookie, '/api/holdem')).json()).toBeNull();
  });

  it('refuses to stand up mid-hand', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/holdem/sit', { buyIn: 400 })).json();
    if (view.handInProgress) {
      expect((await post(cookie, '/api/holdem/leave')).statusCode).toBe(409);
    }
  });

  it('can only ever return chips that were debited', async () => {
    // pysino refunded a table buy-in that had never been debited, minting 4,918 chips.
    // Here the debit and the credit are the two ends of one session.
    const cookie = await signUp();
    for (let round = 0; round < 4; round += 1) {
      const balanceBefore = getBalance(db, userId());
      if (balanceBefore < 100) break;
      const buyIn = Math.min(200, balanceBefore);

      const view = await finishHand(cookie, (await post(cookie, '/api/holdem/sit', { buyIn })).json());
      expect(getBalance(db, userId())).toBe(balanceBefore - buyIn);

      const stack = (view.seats as Array<{ chips: number }>)[0]?.chips ?? 0;
      const left = (await post(cookie, '/api/holdem/leave')).json();
      expect(left.balance).toBe(balanceBefore - buyIn + stack);
      expect(auditBalances(db)).toEqual([]);
    }

    const wagered = db
      .prepare("SELECT COALESCE(SUM(-delta),0) AS n FROM ledger WHERE reason = 'wager'")
      .get() as { n: number };
    const paid = db
      .prepare("SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE reason = 'payout'")
      .get() as { n: number };
    expect(getBalance(db, userId())).toBe(STARTING_CHIPS - wagered.n + paid.n);
  });

  it('records the session as one round', async () => {
    const cookie = await signUp();
    await finishHand(cookie, (await post(cookie, '/api/holdem/sit', { buyIn: 300 })).json());
    await post(cookie, '/api/holdem/leave');
    const rounds = db
      .prepare("SELECT bet, payout FROM rounds WHERE game = 'holdem'")
      .all() as Array<{ bet: number; payout: number }>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.bet).toBe(300);
  });
});

describe('everything stays behind the session cookie', () => {
  const endpoints: Array<[string, string]> = [
    ['POST', '/api/holdem/sit'],
    ['POST', '/api/holdem/deal'],
    ['POST', '/api/holdem/act'],
    ['POST', '/api/holdem/leave'],
    ['GET', '/api/holdem'],
  ];
  for (const [method, url] of endpoints) {
    it(`${method} ${url} needs a signed-in user`, async () => {
      const response = await app.inject({ method: method as 'GET', url, payload: {} });
      expect(response.statusCode).toBe(401);
    });
  }
});

describe('the server seed never leaks', () => {
  it('is absent from every hold em payload', async () => {
    const cookie = await signUp();
    await get(cookie, '/api/fair');
    const secret = (db.prepare('SELECT server_seed FROM seed_pairs').get() as { server_seed: string })
      .server_seed;

    const bodies: string[] = [];
    bodies.push((await post(cookie, '/api/holdem/sit', { buyIn: 300 })).body);
    bodies.push((await get(cookie, '/api/holdem')).body);
    bodies.push((await post(cookie, '/api/holdem/act', { action: 'fold' })).body);
    bodies.push((await post(cookie, '/api/holdem/leave')).body);
    for (const body of bodies) expect(body).not.toContain(secret);
  });
});
