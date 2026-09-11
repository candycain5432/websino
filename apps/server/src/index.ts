/**
 * The Websino server: accounts, chips and one-shot game rounds.
 *
 * Stateful and multiplayer games (crash, blackjack, hold'em tables) will need a
 * WebSocket layer. Dice, limbo, slots and friends resolve in a single request, so they
 * go over plain HTTP and skip that machinery entirely.
 */

import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { z } from 'zod';

import { InvalidBetError } from '@websino/engine';

import { AuthError, SESSION_COOKIE, createSession, destroySession, login, register, resolveSession } from './auth/index.js';
import { openDatabase, type Db } from './db/index.js';
import { auditBalances, getBalance, InsufficientChipsError, recentLedger } from './db/ledger.js';
import { publicState, rotate, setClientSeed } from './fair/seeds.js';
import { GAMES, playRound } from './rounds.js';

const credentials = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

const playBody = z.object({
  game: z.string().min(1).max(32),
  bet: z.number().int().positive(),
  config: z.unknown(),
});

export async function buildServer(db: Db = openDatabase()) {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const requireUser = (request: { cookies: Record<string, string | undefined> }) => {
    const user = resolveSession(db, request.cookies[SESSION_COOKIE]);
    if (!user) throw new AuthError('not signed in');
    return user;
  };

  app.setErrorHandler((error, _request, reply) => {
    // Read these before the instanceof checks below narrow `error` away to nothing.
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'server error';

    if (error instanceof AuthError) return reply.code(401).send({ error: message });
    if (error instanceof InsufficientChipsError) {
      return reply.code(400).send({ error: 'not enough chips' });
    }
    // A rejected stake or an out-of-range game config is the client's fault, not ours.
    if (error instanceof InvalidBetError) return reply.code(400).send({ error: message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'bad request' });

    // Anything unexpected is logged server-side but never echoed back - an internal
    // message could leak schema or filesystem details.
    app.log.error(error);
    return reply.code(status).send({ error: status === 500 ? 'server error' : message });
  });

  app.get('/api/health', async () => ({ ok: true, games: Object.keys(GAMES) }));

  // ------------------------------------------------------------------ auth --
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { username, password } = credentials.parse(request.body);
    const user = await register(db, username, password);
    const { token, expiresAt } = createSession(db, user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(expiresAt),
      secure: process.env.NODE_ENV === 'production',
    });
    return { user, balance: getBalance(db, user.id) };
  });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { username, password } = credentials.parse(request.body);
    const user = await login(db, username, password);
    const { token, expiresAt } = createSession(db, user.id);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(expiresAt),
      secure: process.env.NODE_ENV === 'production',
    });
    return { user, balance: getBalance(db, user.id) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    destroySession(db, request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const user = requireUser(request);
    return {
      user,
      balance: getBalance(db, user.id),
      ledger: recentLedger(db, user.id, 20),
    };
  });

  // ----------------------------------------------------------------- play --
  app.post('/api/round', async (request) => {
    const user = requireUser(request);
    const body = playBody.parse(request.body);
    return playRound(db, user.id, body.game, body.bet, body.config);
  });

  // ------------------------------------------------------------- fairness --
  app.get('/api/fair', async (request) => publicState(db, requireUser(request).id));

  app.post('/api/fair/client-seed', async (request) => {
    const user = requireUser(request);
    const { clientSeed } = z.object({ clientSeed: z.string().max(256) }).parse(request.body);
    return setClientSeed(db, user.id, clientSeed);
  });

  app.post('/api/fair/rotate', async (request) => rotate(db, requireUser(request).id));

  return app;
}

// Only start listening when run directly, so tests can build a server without one.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))) {
  const db = openDatabase();
  const discrepancies = auditBalances(db);
  if (discrepancies.length > 0) {
    console.error('CHIP AUDIT FAILED - wallets disagree with the ledger:', discrepancies);
  }
  const app = await buildServer(db);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`websino server listening on :${port}`);
}
