/**
 * The seam between the game UI and wherever the cards actually come from.
 *
 * Defined before there is a server to talk to, deliberately. Every game screen talks
 * to a `GameTransport` and never learns whether it is speaking to an authoritative
 * server over HTTP or to a local dealer running in this tab. That is what keeps
 * offline mode from becoming a second, drifting implementation of the casino.
 */

export type PlayMode = 'house' | 'practice';

export interface PlayRequest {
  game: string;
  bet: number;
  config: unknown;
}

export interface RoundProof {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  /** Only present once the seed has been rotated and revealed. */
  serverSeed?: string;
  fairVersion: number;
}

export interface PlayResponse {
  payout: number;
  multiplier: number;
  detail: unknown;
  /** Balance after settling, so the UI never has to guess. */
  balance: number;
  proof: RoundProof;
}

export interface FairnessState {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  fairVersion: number;
  previous?: {
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    rounds: number;
  };
}

export interface GameTransport {
  readonly mode: PlayMode;
  getBalance(): Promise<number>;
  play(request: PlayRequest): Promise<PlayResponse>;
  getFairness(): Promise<FairnessState>;
  setClientSeed(clientSeed: string): Promise<FairnessState>;
  rotateServerSeed(): Promise<FairnessState>;
  /** Practice mode only - tops the local wallet back up. */
  topUp?(): Promise<number>;
}
