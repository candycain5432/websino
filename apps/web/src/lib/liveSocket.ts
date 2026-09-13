/**
 * One socket that stays up, for every live room.
 *
 * Reconnection is the normal case, not the exception - a phone locks, a laptop sleeps, a
 * train goes into a tunnel - so it is built in rather than bolted on: backoff, a
 * keepalive, and a subscription that re-sends itself on every connect.
 *
 * This exists because there are now two kinds of live room - a hold'em table and a bingo
 * hall - and none of that plumbing differs between them. It was written once for tables
 * and copying it for bingo would have meant two backoff schedules, two keepalives, and
 * two chances to get the "reconnect re-subscribes but never re-joins" rule wrong. What
 * each room actually owns is its message vocabulary, which is all that is left above.
 *
 * The one rule worth stating: what is replayed on reconnect is a **subscription**, never
 * an action. Re-sending a join would buy in a second time.
 */

/** Backoff between reconnect attempts, in ms. Caps rather than growing forever. */
const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
/** Keepalive, so an idle socket is not dropped by an intermediate proxy. */
const PING_MS = 25_000;

export type LiveStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveSocketOptions {
  /** Server path, e.g. `/ws/tables`. Same origin, so the session cookie rides along. */
  path: string;
  onStatus(status: LiveStatus): void;
  onMessage(payload: Record<string, unknown>): void;
  /** The subscription to replay on every connect, or null if there is nothing to watch. */
  resubscribe(): Record<string, unknown> | null;
}

export class LiveSocket {
  readonly #options: LiveSocketOptions;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #ping: ReturnType<typeof setInterval> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(options: LiveSocketOptions) {
    this.#options = options;
    this.#connect();
  }

  #url(): string {
    // Same origin as the page, so the session cookie rides along with the handshake and
    // there is no second token to mint or leak. In dev the Vite proxy forwards /ws.
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${this.#options.path}`;
  }

  #connect(): void {
    if (this.#closed) return;
    this.#options.onStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url());
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#options.onStatus('open');
      const subscription = this.#options.resubscribe();
      if (subscription) this.send(subscription);
      this.#ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    };

    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message === 'object' && message !== null) {
        this.#options.onMessage(message as Record<string, unknown>);
      }
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

  #scheduleRetry(): void {
    if (this.#retry) return;
    const delay = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)] ?? 8_000;
    this.#attempt += 1;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, delay);
  }

  /** Returns false if the socket is not open, so the caller can say so. */
  send(message: Record<string, unknown>): boolean {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#ping) clearInterval(this.#ping);
    this.#socket?.close();
    this.#socket = null;
    this.#options.onStatus('closed');
  }
}
