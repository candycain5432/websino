/**
 * The socket layer for shared tables.
 *
 * The client sends **intents** and nothing else - `join`, `act`, `leave`. It never sends
 * state, never says when it acted, and never says what it is owed. Every reply is a
 * freshly built, per-viewer redacted snapshot, so a forged message can change what a
 * player asks for and never what they are dealt or paid.
 *
 * Full snapshots rather than diffs, deliberately. A room is small, a diff protocol needs
 * a reconciliation story for a client that missed one, and reconnecting is the normal
 * case here rather than the exception. Sending the whole thing makes "did we drop a
 * frame" a question that cannot arise.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { SESSION_COOKIE, resolveSession } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { RoomError, type RoomRegistry } from './registry.js';

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('watch'), roomId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('join'),
    roomId: z.string().min(1).max(64),
    buyIn: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('act'),
    action: z.enum(['fold', 'check', 'call', 'bet', 'raise']),
    amount: z.number().int().min(0).default(0),
  }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('ping') }),
]);

interface Viewer {
  send(data: string): void;
  userId: string | null;
  username: string | null;
  roomId: string | null;
}

/**
 * Attach the table socket at `/ws/tables`.
 *
 * Auth comes from the same httpOnly session cookie the HTTP routes use - the handshake
 * is an ordinary HTTP request, so there is no second token to mint, leak or expire.
 */
export function registerTableSocket(
  app: FastifyInstance,
  db: Db,
  rooms: RoomRegistry,
): void {
  const viewers = new Set<Viewer>();

  const pushRoom = (roomId: string): void => {
    for (const viewer of viewers) {
      if (viewer.roomId !== roomId) continue;
      try {
        viewer.send(JSON.stringify({
          type: 'state',
          room: rooms.viewFor(roomId, viewer.userId),
        }));
      } catch {
        // A socket that has gone away is cleaned up by its own close handler.
      }
    }
  };

  rooms.onChange(pushRoom);

  app.get('/ws/tables', { websocket: true }, (connection, request) => {
    const user = resolveSession(db, request.cookies[SESSION_COOKIE]);

    const viewer: Viewer = {
      send: (data) => connection.send(data),
      userId: user?.id ?? null,
      username: user?.username ?? null,
      roomId: null,
    };
    viewers.add(viewer);

    // Someone who was already seated is reconnecting: restore the seat rather than
    // leaving their chips in limbo until the grace period expires.
    if (viewer.userId) {
      const existing = rooms.findSeat(viewer.userId);
      if (existing) {
        viewer.roomId = existing.roomId;
        rooms.setConnected(viewer.userId, true);
      }
    }

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
            // Sitting down is what starts a table dealing; watching just wakes one that
            // went idle so a watcher is not staring at a frozen felt.
            rooms.wake(parsed.roomId);
            viewer.send(JSON.stringify({
              type: 'state',
              room: rooms.viewFor(parsed.roomId, viewer.userId),
            }));
            return;

          case 'join': {
            if (!viewer.userId || !viewer.username) return fail('sign in to take a seat');
            rooms.join(viewer.userId, viewer.username, parsed.roomId, parsed.buyIn);
            viewer.roomId = parsed.roomId;
            rooms.wake(parsed.roomId);
            pushRoom(parsed.roomId);
            return;
          }

          case 'act': {
            if (!viewer.userId) return fail('sign in to act');
            rooms.act(viewer.userId, parsed.action, parsed.amount);
            return;
          }

          case 'leave': {
            if (!viewer.userId) return fail('you are not seated');
            const result = rooms.leave(viewer.userId);
            // A request made mid-hand is queued, not done - say so, rather than
            // letting the client believe it has already cashed out.
            viewer.send(JSON.stringify({
              type: result.pending ? 'leaving' : 'left',
              ...result,
            }));
            // No explicit push: the registry saves either way, and every save
            // broadcasts the room through `onChange`.
            return;
          }
        }
      } catch (cause) {
        // A rules or seating problem is the client's to hear about; anything else is
        // logged server-side and reported without detail.
        if (cause instanceof RoomError || cause instanceof Error) {
          fail(cause.message);
          if (!(cause instanceof RoomError)) app.log.error(cause);
          return;
        }
        fail('something went wrong');
      }
    });

    connection.on('close', () => {
      viewers.delete(viewer);
      // The seat keeps its chips and its clock: the grace period decides, not the socket.
      if (viewer.userId) {
        const stillOpen = [...viewers].some((v) => v.userId === viewer.userId);
        if (!stillOpen) rooms.setConnected(viewer.userId, false);
      }
    });
  });
}
