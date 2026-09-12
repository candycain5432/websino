/**
 * The seam between the game UI and wherever the cards actually come from.
 *
 * Defined before there is a server to talk to, deliberately. Every game screen talks
 * to a `GameTransport` and never learns whether it is speaking to an authoritative
 * server over HTTP or to a local dealer running in this tab. That is what keeps
 * offline mode from becoming a second, drifting implementation of the casino.
 */

import type {
  blackjack, BlackjackView, CrashView, holdem, HoldemView, MinesView, VideoPokerView,
} from '@websino/engine';

export type BlackjackAction = blackjack.Action;
export type { BlackjackView, CrashView, HoldemView, MinesView, VideoPokerView };
export type HoldemAction = holdem.HoldemAction;

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

/**
 * Games that span several requests get their own sub-interface rather than being forced
 * through `play()`. A blackjack hand is a conversation and a crash round is a race
 * against a clock; pretending either is a one-shot round would mean encoding a verb in
 * the config object, which is how transports turn into RPC soup.
 */
export interface BlackjackApi {
  /** The hand in progress, or null if there is none. */
  status(): Promise<BlackjackView | null>;
  deal(bet: number): Promise<BlackjackView>;
  act(action: BlackjackAction): Promise<BlackjackView>;
  insurance(buy: boolean): Promise<BlackjackView>;
}

export interface CrashApi {
  status(): Promise<CrashView | null>;
  start(bet: number, autoCashOut: number | null): Promise<CrashView>;
  cashOut(): Promise<CrashView>;
}

export interface MinesApi {
  status(): Promise<MinesView | null>;
  start(bet: number, mines: number): Promise<MinesView>;
  /** One request per tile: the board is never sent while the round is live. */
  reveal(position: number): Promise<MinesView>;
  cashOut(): Promise<MinesView>;
}

export interface VideoPokerApi {
  status(): Promise<VideoPokerView | null>;
  deal(coins: number, coinValue: number): Promise<VideoPokerView>;
  /** Holds travel with the draw, so a dropped call cannot discard kept cards. */
  draw(held: boolean[]): Promise<VideoPokerView>;
}

export interface HoldemApi {
  status(): Promise<HoldemView | null>;
  /** Buy in and take a seat; the first hand is dealt immediately. */
  sit(buyIn: number): Promise<HoldemView>;
  deal(): Promise<HoldemView>;
  act(action: HoldemAction, amount: number): Promise<HoldemView>;
  /** Stand up and take the stack home. Only legal between hands. */
  leave(): Promise<{ balance: number; cashedOut: number }>;
}

export interface GameTransport {
  readonly mode: PlayMode;
  getBalance(): Promise<number>;
  play(request: PlayRequest): Promise<PlayResponse>;
  getFairness(): Promise<FairnessState>;
  setClientSeed(clientSeed: string): Promise<FairnessState>;
  rotateServerSeed(): Promise<FairnessState>;
  readonly blackjack: BlackjackApi;
  readonly crash: CrashApi;
  readonly mines: MinesApi;
  readonly videopoker: VideoPokerApi;
  readonly holdem: HoldemApi;
  /** Practice mode only - tops the local wallet back up. */
  topUp?(): Promise<number>;
}
