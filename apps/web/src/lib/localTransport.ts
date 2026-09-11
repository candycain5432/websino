/**
 * The offline dealer.
 *
 * Runs the same `@websino/engine` rules the server runs, against a locally generated
 * seed, with chips in localStorage. Practice chips are deliberately a separate wallet
 * that never syncs to an account: the client owns this machine, so any "sync my offline
 * winnings" scheme is just an invitation to edit localStorage and press upload.
 */

import { commit, FairStream } from '@websino/fair';
import { dice, limbo, STARTING_CHIPS } from '@websino/engine';
import type { RoundGame } from '@websino/engine';

import type {
  FairnessState, GameTransport, PlayRequest, PlayResponse,
} from './transport.js';

const WALLET_KEY = 'websino.practice.wallet.v1';
const FAIR_KEY = 'websino.practice.fair.v1';
const PRACTICE_STARTING_CHIPS = 10_000;

const GAMES: Record<string, RoundGame<never, unknown>> = {
  dice: dice as unknown as RoundGame<never, unknown>,
  limbo: limbo as unknown as RoundGame<never, unknown>,
};

interface StoredFair {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  previous?: FairnessState['previous'];
}

function randomSeedHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Private windows, cleared storage, blocked cookies - all end up here and all
    // mean the same thing: start fresh rather than crash.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked; the round still played, it just will not persist */
  }
}

export class LocalTransport implements GameTransport {
  readonly mode = 'practice' as const;

  #balance: number;
  #fair: StoredFair;

  constructor() {
    this.#balance = read<number>(WALLET_KEY, PRACTICE_STARTING_CHIPS);
    this.#fair = read<StoredFair>(FAIR_KEY, {
      serverSeed: randomSeedHex(),
      clientSeed: 'practice',
      nonce: 0,
    });
    this.#persist();
  }

  #persist(): void {
    write(WALLET_KEY, this.#balance);
    write(FAIR_KEY, this.#fair);
  }

  async getBalance(): Promise<number> {
    return this.#balance;
  }

  async topUp(): Promise<number> {
    // Practice chips are worthless by design, so a top-up is free and unlimited.
    if (this.#balance < PRACTICE_STARTING_CHIPS) this.#balance = PRACTICE_STARTING_CHIPS;
    this.#persist();
    return this.#balance;
  }

  async play(request: PlayRequest): Promise<PlayResponse> {
    const game = GAMES[request.game];
    if (!game) throw new Error(`unknown game: ${request.game}`);
    if (!Number.isInteger(request.bet) || request.bet < 1) throw new Error('invalid bet');
    if (request.bet > this.#balance) throw new Error('not enough practice chips');

    const stream = new FairStream({
      serverSeed: this.#fair.serverSeed,
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
    });

    const outcome = game.play(request.config as never, request.bet, stream);
    this.#balance = this.#balance - request.bet + outcome.payout;

    const proof = {
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
      fairVersion: 1,
    };

    this.#fair.nonce += 1;
    this.#persist();

    return {
      payout: outcome.payout,
      multiplier: outcome.multiplier,
      detail: outcome.detail,
      balance: this.#balance,
      proof,
    };
  }

  async getFairness(): Promise<FairnessState> {
    return {
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
      fairVersion: 1,
      ...(this.#fair.previous ? { previous: this.#fair.previous } : {}),
    };
  }

  async setClientSeed(clientSeed: string): Promise<FairnessState> {
    const trimmed = clientSeed.trim() || 'practice';
    this.#fair.clientSeed = trimmed.slice(0, 256);
    this.#fair.nonce = 0;
    this.#persist();
    return this.getFairness();
  }

  async rotateServerSeed(): Promise<FairnessState> {
    this.#fair.previous = {
      serverSeed: this.#fair.serverSeed,
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      rounds: this.#fair.nonce,
    };
    this.#fair.serverSeed = randomSeedHex();
    this.#fair.nonce = 0;
    this.#persist();
    return this.getFairness();
  }
}
