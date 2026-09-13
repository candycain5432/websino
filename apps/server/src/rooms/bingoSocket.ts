/**
 * The socket for the bingo hall.
 *
 * Its own endpoint rather than a branch inside the table socket. The two share only
 * session resolution, which is already a function call; everything else differs - the
 * message union, the view type, and what a reconnect has to restore. Folding them together
 * would mean a discriminated union of two unrelated protocols and a `state` frame whose
 * shape depends on which room you happen to be in, which is exactly the kind of payload
 * that compiles and then surprises somebody.
 *
 * Balls are pushed, not polled, but the reveal is still a function of the clock (see
 * `bingo.ts`), so a dropped frame costs nothing: the next one carries the full prefix and
 * the client can animate between them.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { SESSION_COOKIE, resolveSession } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { BingoRoomError, type BingoHall } from './bingo.js';

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('watch'), roomId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('buy'),
    roomId: z.string().min(1).max(64),
    cards: z.number().int().positive(),
    stake: z.number().int().positive(),
  }),
  z.object({ type: z.literal('ping') }),
]);

interface Viewer {
  send(data: string): void;
  userId: string | null;
  username: string | null;
  roomId: string | null;
}

export function registerBingoSocket(app: FastifyInstance, db: Db, hall: BingoHall): void {
  const viewers = new Set<Viewer>();

  const push = (roomId: string): void => {
    for (const viewer of viewers) {
      if (viewer.roomId !== roomId) continue;
      try {
        viewer.send(JSON.stringify({ type: 'state', hall: hall.viewFor(roomId, viewer.userId) }));
      } catch {
        // A socket that has gone away is cleaned up by its own close handler.
      }
    }
  };

  hall.onChange(push);

  app.get('/ws/bingo', { websocket: true }, (connection, request) => {
    const user = resolveSession(db, request.cookies[SESSION_COOKIE]);

    const viewer: Viewer = {
      send: (data) => connection.send(data),
      userId: user?.id ?? null,
      username: user?.username ?? null,
      roomId: null,
    };
    viewers.add(viewer);

    const fail = (message: string): void => {
      viewer.send(JSON.stringify({ type: 'error', message }));
    };

    connection.on('message', (raw: Buffer | string) => {
      let parsed: z.infer<typeof clientMessage>;
      try {
        parsed = clientMessage.parse(JSON.parse(String(raw)));
      } catch {
        fail('bad message');
        return;
      }

      try {
        switch (parsed.type) {
          case 'ping':
            viewer.send(JSON.stringify({ type: 'pong' }));
            return;

          case 'watch':
            viewer.roomId = parsed.roomId;
            // Nothing to wake: the hall runs its own loop whether or not anyone is in it,
            // which is what makes walking in mid-draw work at all.
            viewer.send(JSON.stringify({
              type: 'state',
              hall: hall.viewFor(parsed.roomId, viewer.userId),
            }));
            return;

          case 'buy': {
            if (!viewer.userId || !viewer.username) return fail('sign in to buy a card');
            hall.buy(viewer.userId, viewer.username, parsed.roomId, parsed.cards, parsed.stake);
            viewer.roomId = parsed.roomId;
            // No explicit push: buying saves, and every save broadcasts the hall.
            return;
          }
        }
      } catch (cause) {
        if (cause instanceof BingoRoomError || cause instanceof Error) {
          fail(cause.message);
          if (!(cause instanceof BingoRoomError)) app.log.error(cause);
          return;
        }
        fail('something went wrong');
      }
    });

    connection.on('close', () => {
      viewers.delete(viewer);
      // Nothing to release. A staked round pays out from the tick, so leaving the screen -
      // or losing the connection - cannot cost a player the cards they bought.
    });
  });
}
