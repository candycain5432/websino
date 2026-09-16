/**
 * The seam between the game UI and wherever the cards actually come from.
 *
 * Defined before there is a server to talk to, deliberately. Every game screen talks
 * to a `GameTransport` and never learns whether it is speaking to an authoritative
 * server over HTTP or to a local dealer running in this tab. That is what keeps
 * offline mode from becoming a second, drifting implementation of the casino.
 */

import type {
  blackjack, BlackjackView, CrashView, hilo, HiLoView, holdem, HoldemSnapshot, HoldemView, MinesView,
  towers, TowersView, VideoPokerView,
} from '@websino/engine';

import type { ThemeId } from './theme.js';

export type BlackjackAction = blackjack.Action;
export type { BlackjackView, CrashView, HiLoView, HoldemSnapshot, HoldemView, MinesView, TowersView, VideoPokerView };
export type HiLoGuess = hilo.HiLoGuess;
export type TowersDifficulty = towers.Difficulty;
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

/**
 * What a player has done here, in total.
 *
 * Lifetime figures rather than session ones, because the lobby is where you arrive and
 * the question it should answer is "how have I been doing", not "what happened since I
 * opened this tab". Both transports implement it: the house aggregates its own audit
 * log, and practice keeps its own counters - practice chips never reach an account, so
 * its history must not either.
 */
export interface PlayerStats {
  rounds: number;
  /** Everything ever staked, not the net of it. */
  wagered: number;
  returned: number;
  /** Chips in hand now minus what the account has ever been given for free. */
  net: number;
  peak: number;
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

export interface HiLoApi {
  status(): Promise<HiLoView | null>;
  start(bet: number): Promise<HiLoView>;
  /** One request per guess: the cards ahead are never sent while the run is live. */
  guess(choice: HiLoGuess): Promise<HiLoView>;
  cashOut(): Promise<HiLoView>;
}

export interface TowersApi {
  status(): Promise<TowersView | null>;
  start(bet: number, difficulty: TowersDifficulty): Promise<TowersView>;
  /** One request per row, for the same reason mines takes one per tile. */
  climb(tile: number): Promise<TowersView>;
  cashOut(): Promise<TowersView>;
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

/**
 * What the player has chosen about how the site looks and behaves.
 *
 * One field today. It is an object rather than a bare theme so that adding the next
 * preference is a field rather than a second pair of endpoints, and so the read and the
 * write have the same shape - a `setSettings` that took a theme and returned settings
 * would be the kind of asymmetry that grows a second one.
 */
export interface Settings {
  theme: ThemeId;
}

export interface GameTransport {
  readonly mode: PlayMode;
  getBalance(): Promise<number>;
  /**
   * The account's settings, or this browser's if there is no account.
   *
   * Both transports implement it, which is what lets the settings screen be one screen:
   * it asks the transport, and whether that lands in SQLite or in `localStorage` is the
   * transport's business and nobody else's.
   */
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  getStats(): Promise<PlayerStats>;
  play(request: PlayRequest): Promise<PlayResponse>;
  getFairness(): Promise<FairnessState>;
  setClientSeed(clientSeed: string): Promise<FairnessState>;
  rotateServerSeed(): Promise<FairnessState>;
  readonly blackjack: BlackjackApi;
  readonly crash: CrashApi;
  readonly mines: MinesApi;
  readonly hilo: HiLoApi;
  readonly towers: TowersApi;
  readonly videopoker: VideoPokerApi;
  readonly holdem: HoldemApi;
  /** Practice mode only - tops the local wallet back up. */
  topUp?(): Promise<number>;
}
