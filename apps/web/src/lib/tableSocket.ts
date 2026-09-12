/**
 * The client half of the shared-table protocol.
 *
 * Deliberately thin. It sends **intents** - sit here, call, stand up - and holds the last
 * snapshot the server sent. It computes nothing about the game: no local turn order, no
 * local pot, no optimistic "I probably won that". Every one of those would be a second
 * implementation of the rules, free to disagree with the one that actually deals.
 *
 * Reconnection is the normal case, not the exception - a phone locks, a laptop sleeps,
 * a train goes into a tunnel - so it is built in rather than bolted on. The seat is held
 * server-side for a grace period, and because the server sends whole snapshots there is
 * nothing to replay on the way back: the first message after reconnecting *is* the
 * current truth.
 */

import type { RoomView } from '@websino/engine';

import type { HoldemAction } from './transport.js';

/** Backoff between reconnect attempts, in ms. Caps rather than growing forever. */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
/** Keepalive, so an idle socket is not dropped by an intermediate proxy. */
const PING_MS = 25_000;

export type TableStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TableSocketHandlers {
  onState(room: RoomView): void;
  onStatus(status: TableStatus): void;
  onError(message: string): void;
  /** Fired after standing up, with the credited balance. */
  onLeft?(result: { balance: number; cashedOut: number }): void;
  /** Fired when a stand-up was queued because a hand is still running. */
  onLeaving?(): void;
}

const socketUrl = (): string => {
  // Same origin as the page, so the session cookie rides along with the handshake and
  // there is no second token to mint or leak. In dev the Vite proxy forwards /ws.
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws/tables`;
};

export class TableSocket {
  #socket: WebSocket | null = null;
  #handlers: TableSocketHandlers;
  #attempt = 0;
  #ping: ReturnType<typeof setInterval> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
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
    this.#connect();
  }

  #connect(): void {
    if (this.#closed) return;
    this.#handlers.onStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#handlers.onStatus('open');
      if (this.#watching) this.#send({ type: 'watch', roomId: this.#watching });
      this.#ping = setInterval(() => this.#send({ type: 'ping' }), PING_MS);
    };

    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.#receive(message);
    };

    socket.onclose = () => {
      if (this.#ping) clearInterval(this.#ping);
      this.#ping = null;
      this.#socket = null;
      if (!this.#closed) this.#scheduleRetry();
    };

    // `onerror` is always followed by `onclose`, so the retry is scheduled there once
    // rather than in both places - two paths into the same backoff would double it.
    socket.onerror = () => {};
  }

  #receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const payload = message as Record<string, unknown>;

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

  #scheduleRetry(): void {
    if (this.#retry) return;
    const delay = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)] ?? 8_000;
    this.#attempt += 1;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, delay);
  }

  #send(message: Record<string, unknown>): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  // ---------------------------------------------------------------- intents --

  /** Watch a table. Safe before the socket is open - it is sent on connect. */
  watch(roomId: string): void {
    this.#watching = roomId;
    this.#send({ type: 'watch', roomId });
  }

  sit(roomId: string, buyIn: number): void {
    this.#watching = roomId;
    if (!this.#send({ type: 'join', roomId, buyIn })) {
      this.#handlers.onError('Not connected to the table yet - try again in a moment.');
    }
  }

  act(action: HoldemAction, amount = 0): void {
    if (!this.#send({ type: 'act', action, amount })) {
      this.#handlers.onError('Lost the connection - your clock is still running.');
    }
  }

  stand(): void {
    if (!this.#send({ type: 'leave' })) {
      this.#handlers.onError('Not connected - reconnect to stand up.');
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#ping) clearInterval(this.#ping);
    this.#socket?.close();
    this.#socket = null;
    this.#handlers.onStatus('closed');
  }
}

/** The tables on the floor, for the lobby. */
export async function fetchTables(): Promise<import('@websino/engine').RoomSummary[]> {
  const response = await fetch('/api/tables', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load the tables');
  return (await response.json()).tables;
}
