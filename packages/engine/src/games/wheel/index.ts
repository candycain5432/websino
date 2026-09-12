/**
 * Wheel of Fortune: spin a segmented wheel, take whatever the pointer lands on.
 *
 * Fairness draw order: exactly one `randBelow(segments)`. That index *is* the outcome -
 * the wheel's rotation is animation over a result the server already computed, never
 * the other way round.
 *
 * **Solo, deliberately.** It was originally planned as a shared-round game alongside
 * bingo, but there is nothing shared about it: it is a weighted spin with no other
 * players in it, mechanically a slot with one reel. Making it multiplayer would have
 * widened the multiplayer surface for no gain to anyone at the table.
 *
 * Like plinko, the payouts are *derived*. A risk level names how many segments pay and
 * how steeply, and the multipliers are then scaled so the expected return is the house
 * edge by construction - a wheel whose return to player nobody has to take on trust.
 *
 * **A single spin caps what any segment can pay**, which is worth knowing before anyone
 * asks for a 1000x wheel. Every segment is equally likely, so the payouts must average
 * `1 - edge`; if one segment took everything and the rest paid nothing, it could pay at
 * most `segments * (1 - edge)`. A 30-segment wheel therefore cannot offer more than
 * ~29x, however the prizes are arranged. Wanting a bigger headline means more segments,
 * not a different table - so high risk on the 50-segment wheel is the biggest this game
 * can honestly get.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import type { RoundGame, RoundOutcome } from '../../types.js';

/** Segment counts offered. All divide evenly into the prize patterns below. */
export const SEGMENT_CHOICES = [10, 20, 30, 40, 50] as const;
export type Segments = (typeof SEGMENT_CHOICES)[number];

export type WheelRisk = 'low' | 'medium' | 'high';

/**
 * The shape of a wheel, before it is scaled to the house edge.
 *
 * `winners` is the fraction of segments that pay anything at all, and `spread` is how
 * much more the best segment pays than the worst paying one. Low risk pays often and
 * flatly; high risk is nearly all blanks with one segment worth chasing.
 */
export const RISK_SHAPE: Record<WheelRisk, { winners: number; spread: number }> = {
  low: { winners: 0.7, spread: 3 },
  medium: { winners: 0.4, spread: 20 },
  high: { winners: 0.1, spread: 120 },
};

export interface WheelConfig {
  segments: Segments;
  risk: WheelRisk;
}

export interface WheelDetail {
  /** The segment the pointer stopped on, 0..segments-1. */
  index: number;
  segments: Segments;
  risk: WheelRisk;
  /** Every segment's multiplier, in wheel order, so the client draws what paid. */
  wheel: number[];
  won: boolean;
}

/**
 * Build a wheel.
 *
 * Paying segments are spread evenly around the rim rather than bunched, so the wheel
 * looks like a wheel and a near miss is a genuine near miss. Their relative values climb
 * geometrically from 1 to `spread`, and the whole set is then scaled so that
 * `mean(wheel) === 1 - edge`.
 */
export function wheelFor(config: WheelConfig): number[] {
  const { segments, risk } = config;
  const shape = RISK_SHAPE[risk];
  const winners = Math.max(1, Math.round(segments * shape.winners));

  // Relative weights for the paying segments: 1, ..., spread, geometrically.
  const relative = Array.from({ length: winners }, (_, i) =>
    winners === 1 ? shape.spread : shape.spread ** (i / (winners - 1)),
  );
  const totalRelative = relative.reduce((sum, value) => sum + value, 0);

  // mean(wheel) must be 1 - edge, and only the winners contribute.
  const scale = ((1 - HOUSE_EDGE) * segments) / totalRelative;

  const wheel = Array.from({ length: segments }, () => 0);
  for (let i = 0; i < winners; i += 1) {
    // Even spacing around the rim; the biggest prize sits on its own.
    const at = Math.round((i * segments) / winners) % segments;
    wheel[at] = Math.round((relative[i] as number) * scale * 100) / 100;
  }
  return wheel;
}

/** The exact return to player for a wheel, as its rounded segments actually pay. */
export function returnToPlayer(config: WheelConfig): number {
  const wheel = wheelFor(config);
  return wheel.reduce((sum, value) => sum + value, 0) / wheel.length;
}

export const wheel: RoundGame<WheelConfig, WheelDetail> = {
  id: 'wheel',
  name: 'Wheel of Fortune',
  houseEdge: HOUSE_EDGE,
  defaultConfig: { segments: 30, risk: 'medium' },

  validateConfig(config) {
    if (!SEGMENT_CHOICES.includes(config.segments)) {
      throw new Error(`segments must be one of ${SEGMENT_CHOICES.join(', ')}`);
    }
    if (!(config.risk in RISK_SHAPE)) throw new Error('risk must be low, medium or high');
  },

  play(config, bet, draw: FairSource): RoundOutcome<WheelDetail> {
    this.validateConfig(config);

    const board = wheelFor(config);
    const index = draw.randBelow(config.segments);
    const multiplier = board[index] as number;

    return {
      payout: multiplier > 0 ? payoutFor(bet, multiplier) : 0,
      multiplier,
      detail: {
        index,
        segments: config.segments,
        risk: config.risk,
        wheel: board,
        won: multiplier > 0,
      },
    };
  },
};
