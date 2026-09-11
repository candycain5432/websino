/**
 * Two random sources that must never be confused.
 *
 * `pysino` had a real bug here: hold'em's bot equity estimator and video poker's hint
 * button drew from the *same* stream as the deal, so pressing "hint" perturbed the
 * cards you were about to be dealt and leaked the stream position to anyone watching.
 *
 * The fix is structural rather than a convention. `FairSource` and `CasualSource` carry
 * incompatible brands, so handing a bot the fair stream is a compile error, not a code
 * review catch.
 */

/** Draws that decide money. Verifiable, committed to in advance, server-only. */
export interface FairSource {
  readonly kind: 'fair';
  nextUint32(): number;
  nextFloat(): number;
  randBelow(n: number): number;
  shuffle<T>(items: readonly T[]): T[];
  sample<T>(items: readonly T[], k: number): T[];
  pick<T>(items: readonly T[]): T;
}

/** Draws that decide nothing. Bot personalities, hint sampling, cosmetic jitter. */
export interface CasualSource {
  readonly kind: 'casual';
  nextFloat(): number;
  randBelow(n: number): number;
  shuffle<T>(items: readonly T[]): T[];
  sample<T>(items: readonly T[], k: number): T[];
  pick<T>(items: readonly T[]): T;
}

export interface SeedPair {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export interface FairProof extends SeedPair {
  commitment: string;
  fairVersion: number;
}

export const FAIR_VERSION = 1;
