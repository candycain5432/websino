/**
 * The client half of the shared-table protocol.
 *
 * Deliberately thin. It sends **intents** - sit here, call, stand up - and holds the last
 * snapshot the server sent. It computes nothing about the game: no local turn order, no
 * local pot, no optimistic "I probably won that". Every one of those would be a second
 * implementation of the rules, free to disagree with the one that actually deals.
 *
 * The connection itself - backoff, keepalive, replaying the subscription - lives in
 * `LiveSocket`, which the bingo hall uses too. What is left here is the table's
 * vocabulary, which is the only part that is about poker. Because the server sends whole
 * snapshots there is nothing to replay on the way back from a drop: the first message
 * after reconnecting *is* the current truth.
 */

import type { RoomView } from '@websino/engine';

import { LiveSocket, type LiveStatus } from './liveSocket.js';
import type { HoldemAction } from './transport.js';

export type TableStatus = LiveStatus;

export interface TableSocketHandlers {
  onState(room: RoomView): void;
  onStatus(status: TableStatus): void;
  onError(message: string): void;
  /** Fired after standing up, with the credited balance. */
  onLeft?(result: { balance: number; cashedOut: number }): void;
  /** Fired when a stand-up was queued because a hand is still running. */
  onLeaving?(): void;
}

export class TableSocket {
  readonly #handlers: TableSocketHandlers;
  readonly #socket: LiveSocket;
  /**
   * What the socket should be watching once it is open.
   *
   * Kept so a reconnect re-subscribes by itself. Note it is a *watch*, never a re-join:
   * replaying a join would buy in a second time, and the seat is still held server-side
   * anyway - the reconnect handshake restores it.
   */
  #watching: string | null = null;

  constructor(handlers: TableSocketHandlers) {
    this.#handlers = handlers;
    this.#socket = new LiveSocket({
      path: '/ws/tables',
      onStatus: (status) => handlers.onStatus(status),
      onMessage: (payload) => this.#receive(payload),
      resubscribe: () => (this.#watching ? { type: 'watch', roomId: this.#watching } : null),
    });
  }

  #receive(payload: Record<string, unknown>): void {
    switch (payload.type) {
      case 'state':
        this.#handlers.onState(payload.room as RoomView);
        return;
      case 'leaving':
        this.#handlers.onLeaving?.();
        return;
      case 'left':
        this.#handlers.onLeft?.({
          balance: Number(payload.balance ?? 0),
          cashedOut: Number(payload.cashedOut ?? 0),
        });
        return;
      case 'error':
        this.#handlers.onError(String(payload.message ?? 'Something went wrong'));
        return;
      default:
        // 'pong' and anything a newer server adds: ignored rather than fatal, so an
        // older client keeps working against a newer server.
        return;
    }
  }

  // ---------------------------------------------------------------- intents --

  /** Watch a table. Safe before the socket is open - it is sent on connect. */
  watch(roomId: string): void {
    this.#watching = roomId;
    this.#socket.send({ type: 'watch', roomId });
  }

  sit(roomId: string, buyIn: number): void {
    this.#watching = roomId;
    if (!this.#socket.send({ type: 'join', roomId, buyIn })) {
      this.#handlers.onError('Not connected to the table yet - try again in a moment.');
    }
  }

  act(action: HoldemAction, amount = 0): void {
    if (!this.#socket.send({ type: 'act', action, amount })) {
      this.#handlers.onError('Lost the connection - your clock is still running.');
    }
  }

  stand(): void {
    if (!this.#socket.send({ type: 'leave' })) {
      this.#handlers.onError('Not connected - reconnect to stand up.');
    }
  }

  close(): void {
    this.#socket.close();
  }
}

/** The tables on the floor, for the lobby. */
export async function fetchTables(): Promise<import('@websino/engine').RoomSummary[]> {
  const response = await fetch('/api/tables', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load the tables');
  return (await response.json()).tables;
}
