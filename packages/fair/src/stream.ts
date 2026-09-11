/**
 * The provably-fair byte stream. See ../SPEC.md - that document is normative and this
 * file implements exactly it.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { FAIR_VERSION, type FairProof, type FairSource, type SeedPair } from './types.js';

const BLOCK_BYTES = 32;
const TWO_32 = 4294967296; // 2**32

/** `sha256(serverSeed)` - the commitment published before any betting. */
export function commit(serverSeed: string): string {
  return bytesToHex(sha256(utf8ToBytes(serverSeed)));
}

/** True iff a revealed seed really does hash to the commitment shown earlier. */
export function verifyCommitment(serverSeed: string, commitment: string): boolean {
  return commit(serverSeed) === commitment.toLowerCase();
}

export class FairStream implements FairSource {
  readonly kind = 'fair' as const;

  readonly serverSeed: string;
  readonly clientSeed: string;
  readonly nonce: number;

  #block = 0;
  #buffer: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #bytesUsed = 0;

  constructor({ serverSeed, clientSeed, nonce }: SeedPair) {
    if (!/^[0-9a-f]{64}$/i.test(serverSeed)) {
      throw new Error('serverSeed must be 64 hex characters');
    }
    if (clientSeed.length < 1 || clientSeed.length > 256) {
      throw new Error('clientSeed must be 1-256 characters');
    }
    if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
      throw new Error('nonce must be a uint32');
    }
    this.serverSeed = serverSeed.toLowerCase();
    this.clientSeed = clientSeed;
    this.nonce = nonce;
  }

  /** Total bytes drawn so far. Useful for asserting a game's documented draw cost. */
  get bytesUsed(): number {
    return this.#bytesUsed;
  }

  get commitment(): string {
    return commit(this.serverSeed);
  }

  proof(): FairProof {
    return {
      serverSeed: this.serverSeed,
      clientSeed: this.clientSeed,
      nonce: this.nonce,
      commitment: this.commitment,
      fairVersion: FAIR_VERSION,
    };
  }

  #refill(): void {
    const message = `${this.clientSeed}:${this.nonce}:${this.#block}`;
    this.#buffer = hmac(sha256, utf8ToBytes(this.serverSeed), utf8ToBytes(message));
    this.#offset = 0;
    this.#block += 1;
  }

  nextBytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      if (this.#offset >= this.#buffer.length) this.#refill();
      out[i] = this.#buffer[this.#offset] as number;
      this.#offset += 1;
    }
    this.#bytesUsed += count;
    return out;
  }

  nextUint32(): number {
    const b = this.nextBytes(4);
    // `>>> 0` keeps this an unsigned 32-bit value; `<< 24` alone would go negative.
    return (
      ((b[0] as number) * 0x1000000 +
        ((b[1] as number) << 16) +
        ((b[2] as number) << 8) +
        (b[3] as number)) >>>
      0
    );
  }

  nextFloat(): number {
    return this.nextUint32() / TWO_32;
  }

  randBelow(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > TWO_32) {
      throw new Error(`randBelow needs an integer in [1, 2**32], got ${n}`);
    }
    if (n === 1) return 0;
    // Rejection sampling: discard the ragged tail so every value is equally likely.
    const limit = Math.floor(TWO_32 / n) * n;
    for (;;) {
      const r = this.nextUint32();
      if (r < limit) return r % n;
    }
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.randBelow(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  sample<T>(items: readonly T[], k: number): T[] {
    if (k < 0 || k > items.length) {
      throw new Error(`cannot sample ${k} from ${items.length}`);
    }
    return this.shuffle(items).slice(0, k);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[this.randBelow(items.length)] as T;
  }
}

/** Rebuild the exact stream used for one historical round. */
export function replay(serverSeed: string, clientSeed: string, nonce: number): FairStream {
  return new FairStream({ serverSeed, clientSeed, nonce });
}
