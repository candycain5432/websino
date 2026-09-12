import { mines, STARTING_CHIPS } from '@websino/engine';
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

const signUp = async (username = 'phase2_player') => {
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

const userId = (): string =>
  (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;

describe('roulette over the one-shot round API', () => {
  const bets = (...specs: Array<[string, number[], number]>) =>
    specs.map(([type, selection, amount]) => ({ type, selection, amount }));

  it('settles a spin and moves the balance', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/round', {
      game: 'roulette', bet: 20, config: { bets: bets(['red', [], 10], ['straight', [17], 10]) },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.detail.number).toBeGreaterThanOrEqual(0);
    expect(body.detail.number).toBeLessThanOrEqual(36);
    expect(body.detail.bets).toHaveLength(2);
    expect(body.balance).toBe(STARTING_CHIPS - 20 + body.payout);
    expect(auditBalances(db)).toEqual([]);
  });

  it('rejects a stake that does not match the felt', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/round', {
      game: 'roulette', bet: 50, config: { bets: bets(['red', [], 10]) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/bets total 10 but the stake is 50/);
  });

  it('rejects a bet the felt does not have', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/round', {
      game: 'roulette', bet: 10, config: { bets: bets(['split', [1, 5], 10]) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty felt', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/round', {
      game: 'roulette', bet: 10, config: { bets: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('is listed as an available game', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json().games).toContain('roulette');
  });
});

describe('mines', () => {
  it('starts a board without revealing where the mines are', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/mines/start', { bet: 100, mines: 3 });
    const view = response.json();

    expect(view.state).toBe('playing');
    expect(view.balance).toBe(STARTING_CHIPS - 100);
    // The map is the whole game. It must not be in the payload.
    expect(view.minePositions).toBeUndefined();
    expect(response.body).not.toContain('minePositions');
  });

  it('keeps the map in the database, not in the response', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/mines/start', { bet: 100, mines: 3 });
    const row = db
      .prepare("SELECT state_json FROM game_sessions WHERE game = 'mines'")
      .get() as { state_json: string };
    const positions = (JSON.parse(row.state_json) as { round: mines.MinesRound })
      .round.minePositions;
    expect(positions).toHaveLength(3);
    expect(response.body).not.toContain(JSON.stringify(positions));
  });

  it('reveals one tile at a time and climbs the ladder', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 1 });

    // With one mine, the first pick is safe 24 times in 25.
    const view = (await post(cookie, '/api/mines/reveal', { position: 0 })).json();
    if (view.state === 'playing') {
      expect(view.picks).toBe(1);
      expect(view.multiplier).toBeGreaterThan(1);
      expect(view.nextMultiplier).toBeGreaterThan(view.multiplier);
      expect(view.minePositions).toBeUndefined();
    } else {
      // Busted on the first tile: now the map is public, because the round is over.
      expect(view.state).toBe('busted');
      expect(view.minePositions).toHaveLength(1);
    }
  });

  it('shows the board once the round ends', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 3 });
    let view = (await post(cookie, '/api/mines/reveal', { position: 0 })).json();
    if (view.state === 'playing') view = (await post(cookie, '/api/mines/cashout')).json();

    expect(['busted', 'cashed']).toContain(view.state);
    expect(view.minePositions).toHaveLength(3);
    expect(auditBalances(db)).toEqual([]);
  });

  it('refuses the same tile twice', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 1 });
    const first = (await post(cookie, '/api/mines/reveal', { position: 0 })).json();
    if (first.state !== 'playing') return; // busted; nothing to repeat

    const again = await post(cookie, '/api/mines/reveal', { position: 0 });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/already revealed/);
  });

  it('refuses a tile off the board', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 1 });
    expect((await post(cookie, '/api/mines/reveal', { position: 25 })).statusCode).toBe(400);
    expect((await post(cookie, '/api/mines/reveal', { position: -1 })).statusCode).toBe(400);
  });

  it('refuses to cash out before revealing anything', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 3 });
    const response = await post(cookie, '/api/mines/cashout');
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/at least one tile/);
  });

  it('refuses a second board while one is live', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/mines/start', { bet: 100, mines: 3 });
    expect((await post(cookie, '/api/mines/start', { bet: 100, mines: 3 })).statusCode).toBe(409);
  });

  it('refuses to reveal with no board', async () => {
    const cookie = await signUp();
    expect((await post(cookie, '/api/mines/reveal', { position: 0 })).statusCode).toBe(409);
  });

  it('rejects a mine count off the scale', async () => {
    const cookie = await signUp();
    expect((await post(cookie, '/api/mines/start', { bet: 10, mines: 0 })).statusCode).toBe(400);
    expect((await post(cookie, '/api/mines/start', { bet: 10, mines: 25 })).statusCode).toBe(400);
  });

  it('conserves chips across many boards', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 25; i += 1) {
      if (getBalance(db, userId()) < 20) break;
      await post(cookie, '/api/mines/start', { bet: 10, mines: 5 });
      const view = (await post(cookie, '/api/mines/reveal', { position: i % 25 })).json();
      if (view.state === 'playing') await post(cookie, '/api/mines/cashout');
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
});

describe('video poker', () => {
  it('deals five cards and takes the stake', async () => {
    const cookie = await signUp();
    const view = (await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 10 })).json();

    expect(view.cards).toHaveLength(5);
    expect(view.phase).toBe('holding');
    expect(view.bet).toBe(50);
    expect(view.balance).toBe(STARTING_CHIPS - 50);
  });

  it('never ships the undrawn deck', async () => {
    // The whole deck is shuffled at deal, so the replacements are already decided.
    // Sending it would let a player pick holds with the answers in front of them.
    const cookie = await signUp();
    const response = await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 10 });
    const row = db
      .prepare("SELECT state_json FROM game_sessions WHERE game = 'videopoker'")
      .get() as { state_json: string };
    const deck = (JSON.parse(row.state_json) as { round: { deck: number[] } }).round.deck;

    expect(deck).toHaveLength(52);
    expect(response.body).not.toContain(JSON.stringify(deck));
    // The next five cards - the ones a full redraw would produce - must not be visible.
    expect(response.body).not.toContain(JSON.stringify(deck.slice(5, 10)));
  });

  it('replaces the unheld cards and settles', async () => {
    const cookie = await signUp();
    const dealt = (await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 10 })).json();
    const held = [true, false, true, false, true];
    const done = (await post(cookie, '/api/videopoker/draw', { held })).json();

    expect(done.phase).toBe('complete');
    expect(done.drawn).toEqual([1, 3]);
    for (let i = 0; i < 5; i += 1) if (held[i]) expect(done.cards[i]).toBe(dealt.cards[i]);
    expect(done.balance).toBe(STARTING_CHIPS - 50 + done.payout);
    expect(auditBalances(db)).toEqual([]);
  });

  it('names the hand it paid for', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 30; i += 1) {
      await post(cookie, '/api/videopoker/deal', { coins: 1, coinValue: 1 });
      const done = (await post(cookie, '/api/videopoker/draw', {
        held: [true, true, true, true, true],
      })).json();
      if (done.result) {
        expect(done.resultName).toBeTruthy();
        expect(done.payout).toBeGreaterThan(0);
        return;
      }
      expect(done.payout).toBe(0);
    }
  });

  it('refuses a second hand while one is live', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 10 });
    expect((await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 10 })).statusCode)
      .toBe(409);
  });

  it('refuses to draw with no hand', async () => {
    const cookie = await signUp();
    const response = await post(cookie, '/api/videopoker/draw', {
      held: [false, false, false, false, false],
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects an illegal coin count', async () => {
    const cookie = await signUp();
    expect((await post(cookie, '/api/videopoker/deal', { coins: 6, coinValue: 1 })).statusCode).toBe(400);
    expect((await post(cookie, '/api/videopoker/deal', { coins: 0, coinValue: 1 })).statusCode).toBe(400);
  });

  it('rejects a hold mask of the wrong length', async () => {
    const cookie = await signUp();
    await post(cookie, '/api/videopoker/deal', { coins: 1, coinValue: 1 });
    expect((await post(cookie, '/api/videopoker/draw', { held: [true, false] })).statusCode).toBe(400);
  });

  it('conserves chips across many hands', async () => {
    const cookie = await signUp();
    for (let i = 0; i < 30; i += 1) {
      if (getBalance(db, userId()) < 10) break;
      await post(cookie, '/api/videopoker/deal', { coins: 5, coinValue: 1 });
      await post(cookie, '/api/videopoker/draw', { held: [false, true, false, true, false] });
      expect(auditBalances(db)).toEqual([]);
    }
  });
});

describe('everything stays behind the session cookie', () => {
  const endpoints: Array<[string, string]> = [
    ['POST', '/api/mines/start'],
    ['POST', '/api/mines/reveal'],
    ['POST', '/api/mines/cashout'],
    ['GET', '/api/mines'],
    ['POST', '/api/videopoker/deal'],
    ['POST', '/api/videopoker/hold'],
    ['POST', '/api/videopoker/draw'],
    ['GET', '/api/videopoker'],
  ];

  for (const [method, url] of endpoints) {
    it(`${method} ${url} needs a signed-in user`, async () => {
      const response = await app.inject({ method: method as 'GET', url, payload: {} });
      expect(response.statusCode).toBe(401);
    });
  }
});

describe('the server seed never leaks from the new games', () => {
  it('is absent from every payload', async () => {
    const cookie = await signUp();
    await get(cookie, '/api/fair');
    const secret = (db.prepare('SELECT server_seed FROM seed_pairs').get() as { server_seed: string })
      .server_seed;

    const bodies: string[] = [];
    bodies.push((await post(cookie, '/api/round', {
      game: 'roulette', bet: 10, config: { bets: [{ type: 'red', selection: [], amount: 10 }] },
    })).body);
    bodies.push((await post(cookie, '/api/mines/start', { bet: 10, mines: 3 })).body);
    bodies.push((await post(cookie, '/api/mines/reveal', { position: 0 })).body);
    bodies.push((await get(cookie, '/api/mines')).body);
    bodies.push((await post(cookie, '/api/mines/cashout')).body);
    bodies.push((await post(cookie, '/api/videopoker/deal', { coins: 1, coinValue: 1 })).body);
    bodies.push((await get(cookie, '/api/videopoker')).body);
    bodies.push((await post(cookie, '/api/videopoker/draw', {
      held: [true, true, true, true, true],
    })).body);

    for (const body of bodies) expect(body).not.toContain(secret);
  });
});
