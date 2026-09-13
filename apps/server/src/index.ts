/**
 * The Websino server: accounts, chips and one-shot game rounds.
 *
 * Dice, limbo and slots resolve in a single request. Blackjack and crash span several,
 * so they keep server-held state in `sessions.ts` - but they are still request/response,
 * because only one player is at the table. A WebSocket layer is what *shared* tables
 * need (hold'em, and later shared blackjack and roulette), and it can wait until there
 * is something to broadcast.
 */

import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { z } from 'zod';

import {
  blackjack, hilo, holdem, InvalidBetError, mines, towers, videopoker,
} from '@websino/engine';

import { AuthError, SESSION_COOKIE, createSession, destroySession, login, register, resolveSession } from './auth/index.js';
import { openDatabase, type Db } from './db/index.js';
import { auditBalances, getBalance, InsufficientChipsError, recentLedger } from './db/ledger.js';
import { publicState, rotate, setClientSeed } from './fair/seeds.js';
import { GAMES, playRound } from './rounds.js';
import { BingoHall } from './rooms/bingo.js';
import { registerBingoSocket } from './rooms/bingoSocket.js';
import { RoomError, RoomRegistry } from './rooms/registry.js';
import { registerTableSocket } from './rooms/socket.js';
import {
  actBlackjack, blackjackStatus, cashOutCrash, cashOutMines, crashStatus,
  dealBlackjack, dealVideoPoker, drawVideoPoker, holdVideoPoker, insureBlackjack,
  actHoldem, cashOutHiLo, cashOutTowers, climbTowers, dealHoldem, guessHiLo,
  hiloStatus, holdemStatus, leaveHoldem, minesStatus, NoSuchSessionError,
  revealMinesTile, SessionConflictError, sitHoldem, startCrashRound, startHiLoRound,
  startMinesRound, startTowersRound, towersStatus, videoPokerStatus,
} from './sessions.js';

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
  await app.register(websocket);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Shared tables tick on their own clock, so the registry outlives any one request.
  const rooms = new RoomRegistry(db);
  const bingoHall = new BingoHall(db);

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
    if (error instanceof NoSuchSessionError) return reply.code(409).send({ error: message });
    if (error instanceof SessionConflictError) return reply.code(409).send({ error: message });
    if (error instanceof RoomError) return reply.code(409).send({ error: message });
    // An illegal move is the client's mistake. Answering 500 would both mislead the
    // client and bury genuine server faults in the log.
    if (
      error instanceof blackjack.IllegalActionError ||
      error instanceof mines.MinesError ||
      error instanceof holdem.HoldemError ||
      error instanceof hilo.HiLoError ||
      error instanceof towers.TowersError ||
      error instanceof videopoker.VideoPokerError
    ) {
      return reply.code(400).send({ error: message });
    }

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

  // ---------------------------------------------------------------- crash --
  // A round advances with the wall clock, so it needs its own endpoints. The client
  // animates the curve locally but never decides the outcome: the server dates every
  // cash-out by its own clock and holds the crash point until the round is over.
  app.post('/api/crash/start', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        bet: z.number().int().positive(),
        autoCashOut: z.number().int().min(101).nullable().default(null),
      })
      .parse(request.body);
    return startCrashRound(db, user.id, body.bet, body.autoCashOut);
  });

  app.post('/api/crash/cashout', async (request) => cashOutCrash(db, requireUser(request).id));

  app.get('/api/crash', async (request) => crashStatus(db, requireUser(request).id));

  // ------------------------------------------------------------ blackjack --
  app.post('/api/blackjack/deal', async (request) => {
    const user = requireUser(request);
    const { bet } = z.object({ bet: z.number().int().positive() }).parse(request.body);
    return dealBlackjack(db, user.id, bet);
  });

  app.post('/api/blackjack/action', async (request) => {
    const user = requireUser(request);
    const { action } = z
      .object({ action: z.enum(['hit', 'stand', 'double', 'split', 'surrender']) })
      .parse(request.body);
    return actBlackjack(db, user.id, action);
  });

  app.post('/api/blackjack/insurance', async (request) => {
    const user = requireUser(request);
    const { buy } = z.object({ buy: z.boolean() }).parse(request.body);
    return insureBlackjack(db, user.id, buy);
  });

  app.get('/api/blackjack', async (request) => blackjackStatus(db, requireUser(request).id));

  // ---------------------------------------------------------------- mines --
  // One request per tile. The board is never sent while the round is live, so a
  // reveal has to be asked for and the server answers one square at a time.
  app.post('/api/mines/start', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        bet: z.number().int().positive(),
        mines: z.number().int().min(1).max(24),
      })
      .parse(request.body);
    return startMinesRound(db, user.id, body.bet, body.mines);
  });

  app.post('/api/mines/reveal', async (request) => {
    const user = requireUser(request);
    const { position } = z
      .object({ position: z.number().int().min(0).max(24) })
      .parse(request.body);
    return revealMinesTile(db, user.id, position);
  });

  app.post('/api/mines/cashout', async (request) => cashOutMines(db, requireUser(request).id));

  app.get('/api/mines', async (request) => minesStatus(db, requireUser(request).id));

  // ---------------------------------------------------------------- hi-lo --
  // The run is drawn at `start` and the cards ahead never leave the server; a guess
  // turns exactly one of them over.
  app.post('/api/hilo/start', async (request) => {
    const user = requireUser(request);
    const { bet } = z.object({ bet: z.number().int().positive() }).parse(request.body);
    return startHiLoRound(db, user.id, bet);
  });

  app.post('/api/hilo/guess', async (request) => {
    const user = requireUser(request);
    const { guess } = z
      .object({ guess: z.enum(['higher', 'lower']) })
      .parse(request.body);
    return guessHiLo(db, user.id, guess);
  });

  app.post('/api/hilo/cashout', async (request) => cashOutHiLo(db, requireUser(request).id));

  app.get('/api/hilo', async (request) => hiloStatus(db, requireUser(request).id));

  // --------------------------------------------------------------- towers --
  // One request per row, for the same reason mines takes one per tile: the trap map
  // is the game, so it stays here until the round is over.
  app.post('/api/towers/start', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        bet: z.number().int().positive(),
        difficulty: z.enum(['easy', 'medium', 'hard', 'expert', 'master']),
      })
      .parse(request.body);
    return startTowersRound(db, user.id, body.bet, body.difficulty);
  });

  app.post('/api/towers/climb', async (request) => {
    const user = requireUser(request);
    // The upper bound is the widest row any difficulty has; the engine rejects a tile
    // that is not in *this* round's row, which is the check that actually matters.
    const { tile } = z.object({ tile: z.number().int().min(0).max(3) }).parse(request.body);
    return climbTowers(db, user.id, tile);
  });

  app.post('/api/towers/cashout', async (request) => cashOutTowers(db, requireUser(request).id));

  app.get('/api/towers', async (request) => towersStatus(db, requireUser(request).id));

  // ----------------------------------------------------------- videopoker --
  app.post('/api/videopoker/deal', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        coins: z.number().int().min(1).max(5),
        coinValue: z.number().int().positive(),
      })
      .parse(request.body);
    return dealVideoPoker(db, user.id, body.coins, body.coinValue);
  });

  app.post('/api/videopoker/hold', async (request) => {
    const user = requireUser(request);
    const { held } = z
      .object({ held: z.array(z.boolean()).length(5) })
      .parse(request.body);
    return holdVideoPoker(db, user.id, held);
  });

  app.post('/api/videopoker/draw', async (request) => {
    const user = requireUser(request);
    const { held } = z
      .object({ held: z.array(z.boolean()).length(5) })
      .parse(request.body);
    return drawVideoPoker(db, user.id, held);
  });

  app.get('/api/videopoker', async (request) => videoPokerStatus(db, requireUser(request).id));

  // -------------------------------------------------------------- hold'em --
  // One human against bots, so this is still request/response: the bots act inside the
  // same request that the human's action arrives on. Shared tables with several humans
  // are what need a socket, and that is the next piece.
  app.post('/api/holdem/sit', async (request) => {
    const user = requireUser(request);
    const { buyIn } = z.object({ buyIn: z.number().int().positive() }).parse(request.body);
    return sitHoldem(db, user.id, buyIn);
  });

  app.post('/api/holdem/deal', async (request) => dealHoldem(db, requireUser(request).id));

  app.post('/api/holdem/act', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        action: z.enum(['fold', 'check', 'call', 'bet', 'raise']),
        amount: z.number().int().min(0).default(0),
      })
      .parse(request.body);
    return actHoldem(db, user.id, body.action, body.amount);
  });

  app.post('/api/holdem/leave', async (request) => leaveHoldem(db, requireUser(request).id));

  app.get('/api/holdem', async (request) => holdemStatus(db, requireUser(request).id));

  // --------------------------------------------------------- shared tables --
  // The socket at /ws/tables carries everything that happens *at* a table. These two
  // routes exist so the lobby can list tables and a reconnecting client can find its
  // seat before opening a socket.
  app.get('/api/tables', async () => ({ tables: rooms.list() }));

  app.get('/api/tables/mine', async (request) => {
    const user = requireUser(request);
    const found = rooms.findSeat(user.id);
    return found ? { ...found, room: rooms.viewFor(found.roomId, user.id) } : null;
  });

  registerTableSocket(app, db, rooms);

  // ------------------------------------------------------------ bingo hall --
  // The other shape of shared room: no seats, no turn clock, one ball sequence for
  // everybody. `/ws/bingo` carries the round; this route is for the lobby.
  app.get('/api/bingo', async () => ({ halls: bingoHall.list() }));

  // The round a player is already in, for a client that reloaded mid-draw - and the
  // honest place to check redaction, since a payload cannot be talked out of what it
  // does not contain.
  app.get('/api/bingo/mine', async (request) =>
    bingoHall.viewFor('bingo-hall', requireUser(request).id));

  registerBingoSocket(app, db, bingoHall);

  // Started here rather than in the registry's constructor so a test can build a server
  // without a background timer running under it.
  if (process.env.WEBSINO_NO_TICK !== '1') {
    rooms.start();
    bingoHall.start();
  }
  app.addHook('onClose', async () => {
    rooms.stop();
    bingoHall.stop();
  });

  // Exposed for tests: driving the clock by hand beats sleeping for twenty seconds.
  (app as unknown as { rooms: RoomRegistry }).rooms = rooms;
  (app as unknown as { bingoHall: BingoHall }).bingoHall = bingoHall;

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
