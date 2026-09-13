/**
 * The client half of the bingo protocol.
 *
 * Two intents, and that is the whole vocabulary: watch a hall, buy into the round. There
 * is nothing to take turns over, so there is no action to send and no clock to answer.
 *
 * Balls arrive as a prefix of the sequence, and the server also says how far apart they
 * are (`ballMs`). That pairing is what lets the screen animate without inventing anything:
 * the client interpolates *within* what it has already been told, never ahead of it, so a
 * dropped frame costs nothing and a fast connection cannot see a ball early.
 */

import type { BingoSummary, BingoView } from '@websino/engine';

import { LiveSocket, type LiveStatus } from './liveSocket.js';

export type BingoStatus = LiveStatus;

export interface BingoSocketHandlers {
  onState(hall: BingoView): void;
  onStatus(status: BingoStatus): void;
  onError(message: string): void;
}

export class BingoSocket {
  readonly #handlers: BingoSocketHandlers;
  readonly #socket: LiveSocket;
  /**
   * The hall to re-watch on connect.
   *
   * A watch, never a replayed buy: the stake is already debited and the round already
   * holds the cards, so re-sending it would buy a second set.
   */
  #watching: string | null = null;

  constructor(handlers: BingoSocketHandlers) {
    this.#handlers = handlers;
    this.#socket = new LiveSocket({
      path: '/ws/bingo',
      onStatus: (status) => handlers.onStatus(status),
      onMessage: (payload) => this.#receive(payload),
      resubscribe: () => (this.#watching ? { type: 'watch', roomId: this.#watching } : null),
    });
  }

  #receive(payload: Record<string, unknown>): void {
    switch (payload.type) {
      case 'state':
        this.#handlers.onState(payload.hall as BingoView);
        return;
      case 'error':
        this.#handlers.onError(String(payload.message ?? 'Something went wrong'));
        return;
      default:
        return;
    }
  }

  watch(roomId: string): void {
    this.#watching = roomId;
    this.#socket.send({ type: 'watch', roomId });
  }

  buy(roomId: string, cards: number, stake: number): void {
    this.#watching = roomId;
    if (!this.#socket.send({ type: 'buy', roomId, cards, stake })) {
      this.#handlers.onError('Not connected to the hall yet - try again in a moment.');
    }
  }

  close(): void {
    this.#socket.close();
  }
}

/** The halls on the floor, for the lobby. */
export async function fetchBingoHalls(): Promise<BingoSummary[]> {
  const response = await fetch('/api/bingo', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load the bingo hall');
  return (await response.json()).halls;
}
