import { STARTING_CHIPS } from '@websino/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/index.js';
import { SESSION_COOKIE, register } from '../src/auth/index.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { applyLedger, auditBalances, getBalance } from '../src/db/ledger.js';
import { activeSeedPair, publicState, rotate } from '../src/fair/seeds.js';
import { playRound } from '../src/rounds.js';

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

const signUp = async (username = 'player_one', password = 'correct-horse') => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  return { response, cookie: `${SESSION_COOKIE}=${cookie?.value ?? ''}` };
};

describe('accounts', () => {
  it('registers, starts with the right chips, and sets an httpOnly cookie', async () => {
    const { response } = await signUp();
    expect(response.statusCode).toBe(200);
    expect(response.json().balance).toBe(STARTING_CHIPS);

    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('never stores the password in plain text', async () => {
    await signUp('secretive', 'hunter2-hunter2');
    const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash).not.toContain('hunter2');
    expect(row.password_hash.startsWith('$argon2')).toBe(true);
  });

  it('refuses a duplicate username regardless of case', async () => {
    await signUp('Taken');
    const second = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'taken', password: 'another-password' },
    });
    expect(second.statusCode).toBe(401);
  });

  it.each([
    ['ab', 'too short'], ['has spaces', 'bad characters'], ['a'.repeat(21), 'too long'],
  ])('rejects the username %s', async (username) => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username, password: 'long-enough-password' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a short password', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'shorty', password: 'abc' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('logs in and rejects a wrong password', async () => {
    await signUp('returning', 'my-real-password');
    const good = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'returning', password: 'my-real-password' },
    });
    expect(good.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'returning', password: 'not-my-password' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('gives the same answer for an unknown user as for a wrong password', async () => {
    const unknown = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'ghost', password: 'whatever-goes-here' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('wrong username or password');
  });

  it('refuses protected routes without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/round', payload: { game: 'dice', bet: 1, config: {} } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('the ledger is the only way chips move', () => {
  it('starts every account in balance', async () => {
    await signUp();
    expect(auditBalances(db)).toEqual([]);
  });

  it('refuses to let a balance go negative', async () => {
    const user = await register(db, 'broke_guy', 'password-here');
    expect(() => applyLedger(db, user.id, [{ delta: -999_999, reason: 'wager' }])).toThrow();
    expect(getBalance(db, user.id)).toBe(STARTING_CHIPS);
  });

  it('keeps wallet and ledger in agreement over many rounds', async () => {
    const user = await register(db, 'grinder', 'password-here');
    for (let i = 0; i < 200; i += 1) {
      playRound(db, user.id, 'dice', 10, { target: 5000, direction: 'over' });
    }
    expect(auditBalances(db)).toEqual([]);
  });

  it('moves the balance by exactly (payout - bet)', async () => {
    const user = await register(db, 'exact', 'password-here');
    for (let i = 0; i < 50; i += 1) {
      const before = getBalance(db, user.id);
      const result = playRound(db, user.id, 'limbo', 25, { target: 200 });
      expect(result.balance).toBe(before - 25 + result.payout);
      expect(getBalance(db, user.id)).toBe(result.balance);
    }
  });

  it('applies a multi-entry round atomically', async () => {
    const user = await register(db, 'atomic', 'password-here');
    const before = getBalance(db, user.id);
    // A stake larger than the balance must leave nothing behind - no half-settled round.
    expect(() =>
      applyLedger(db, user.id, [
        { delta: -before, reason: 'wager' },
        { delta: -1, reason: 'wager' },
      ]),
    ).toThrow();
    expect(getBalance(db, user.id)).toBe(before);
    expect(auditBalances(db)).toEqual([]);
  });
});

describe('playing a round', () => {
  it('plays, settles and records an audit row', async () => {
    const { cookie } = await signUp();
    const response = await app.inject({
      method: 'POST', url: '/api/round', headers: { cookie },
      payload: { game: 'dice', bet: 50, config: { target: 5000, direction: 'over' } },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.balance).toBe(STARTING_CHIPS - 50 + body.payout);
    expect(body.proof.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);

    const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(body.roundId);
    expect(round).toBeTruthy();
  });

  it('rejects a bet larger than the balance', async () => {
    const { cookie } = await signUp();
    const response = await app.inject({
      method: 'POST', url: '/api/round', headers: { cookie },
      payload: { game: 'dice', bet: 999_999, config: { target: 5000, direction: 'over' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a forged config that would guarantee a win', async () => {
    const { cookie } = await signUp();
    // 100% win chance - the server must apply its own rules, not the client's claim.
    const response = await app.inject({
      method: 'POST', url: '/api/round', headers: { cookie },
      payload: { game: 'dice', bet: 10, config: { target: 0, direction: 'over' } },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it.each([
    ['negative bet', { game: 'dice', bet: -10, config: { target: 5000, direction: 'over' } }],
    ['fractional bet', { game: 'dice', bet: 1.5, config: { target: 5000, direction: 'over' } }],
    ['unknown game', { game: 'roulette-of-doom', bet: 10, config: {} }],
  ])('rejects %s', async (_label, payload) => {
    const { cookie } = await signUp();
    const response = await app.inject({ method: 'POST', url: '/api/round', headers: { cookie }, payload });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('advances the nonce once per round', async () => {
    const user = await register(db, 'noncer', 'password-here');
    expect(publicState(db, user.id).nonce).toBe(0);
    playRound(db, user.id, 'dice', 10, { target: 5000, direction: 'over' });
    playRound(db, user.id, 'dice', 10, { target: 5000, direction: 'over' });
    expect(publicState(db, user.id).nonce).toBe(2);
  });
});

describe('the server seed never leaks', () => {
  it('is absent from every client-bound payload', async () => {
    const { cookie } = await signUp();
    // Seed pairs are created on first use, so touch the endpoint before reading one.
    await app.inject({ method: 'GET', url: '/api/fair', headers: { cookie } });
    const secret = (db.prepare('SELECT server_seed FROM seed_pairs').get() as { server_seed: string })
      .server_seed;

    const bodies: string[] = [];
    for (const [method, url, payload] of [
      ['GET', '/api/me', undefined],
      ['GET', '/api/fair', undefined],
      ['POST', '/api/round', { game: 'dice', bet: 10, config: { target: 5000, direction: 'over' } }],
      ['POST', '/api/fair/client-seed', { clientSeed: 'mine' }],
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
      bodies.push(response.body);
    }

    // The single worst bug this system could have, so it is checked directly.
    for (const body of bodies) expect(body).not.toContain(secret);
  });

  it('reveals the old seed on rotation, and it verifies against its commitment', async () => {
    const user = await register(db, 'rotator', 'password-here');
    const before = activeSeedPair(db, user.id);
    playRound(db, user.id, 'dice', 10, { target: 5000, direction: 'over' });

    const after = rotate(db, user.id);
    expect(after.previous?.serverSeed).toBe(before.server_seed);
    expect(after.previous?.rounds).toBe(1);
    // A fresh, still-secret seed is now active.
    expect(after.serverSeedHash).not.toBe(before.server_seed_hash);
  });

  it('lets a revealed round be recomputed independently', async () => {
    const { commit, FairStream } = await import('@websino/fair');
    const { dice } = await import('@websino/engine');

    const user = await register(db, 'auditor', 'password-here');
    const config = { target: 5000, direction: 'over' as const };
    const result = playRound(db, user.id, 'dice', 100, config);
    const revealed = rotate(db, user.id).previous!;

    // This is exactly what the verifier UI does: rebuild the stream from the three
    // strings and check the house's reported outcome.
    expect(commit(revealed.serverSeed)).toBe(result.proof.serverSeedHash);
    const replayed = dice.play(
      config, 100,
      new FairStream({
        serverSeed: revealed.serverSeed,
        clientSeed: result.proof.clientSeed,
        nonce: result.proof.nonce,
      }),
    );
    expect(replayed.payout).toBe(result.payout);
    expect(replayed.detail).toEqual(result.detail);
  });
});
