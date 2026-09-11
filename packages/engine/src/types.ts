/**
 * The contract every one-shot game implements.
 *
 * "One-shot" means the whole round resolves from a single request: bet in, outcome out,
 * no intermediate player decisions. Dice, limbo, slots, plinko, wheel and solo roulette
 * all fit, which is why they can travel over plain HTTP and skip the WebSocket machinery
 * entirely. Stateful games (blackjack, mines, crash, poker) get a richer interface later.
 */

import type { FairSource } from '@websino/fair';

export interface RoundOutcome<Detail = unknown> {
  /** Gross chips returned, stake included. 0 means the stake was lost. */
  payout: number;
  /** Effective multiplier on the stake, for display. */
  multiplier: number;
  /** Game-specific public result - safe to send to the client. */
  detail: Detail;
}

export interface RoundGame<Config, Detail> {
  readonly id: string;
  readonly name: string;
  /** RTP is 1 - houseEdge. Used by the UI and asserted by the RTP tests. */
  readonly houseEdge: number;
  readonly defaultConfig: Config;
  /** Throws if the configuration is out of range. Server calls this before playing. */
  validateConfig(config: Config): void;
  /** Documented draw order lives in each game's fairness notes. */
  play(config: Config, bet: number, draw: FairSource): RoundOutcome<Detail>;
}
