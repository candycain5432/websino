/**
 * Crash: a multiplier climbs from 1.00x and dies at a point drawn up front.
 *
 * **Fairness draw order.** Exactly one `nextFloat()`, at round start, via limbo's
 * `drawMultiplier`. Crash and limbo are the same distribution - `P(result >= x) =
 * (1 - edge) / x` - so cashing out at any target is worth the same and the tail is fat.
 * Sharing the draw function means the two games cannot drift apart.
 *
 * **Why integer ticks.** pysino advanced a float `elapsed` by a frame delta and asked
 * `multiplier_at(elapsed) >= crash_point` with both sides floats rounded to two places.
 * Whether the curve *reached* the crash point then depended on frame timing, so the same
 * seed could pay differently on a slow machine. Here the curve is a pure function of an
 * integer tick index, and the crash tick is computed once. "Did it reach it" has an exact
 * answer that no amount of lag can change.
 *
 * The module is deliberately clock-free: it converts ticks to multipliers and back, and
 * the caller decides what a tick means. The server maps its own monotonic clock onto ticks
 * so a client cannot cash out in the past.
 */

import type { FairSource } from '@websino/fair';

import { HOUSE_EDGE, payoutFor } from '../../economy/chips.js';
import { drawMultiplier, MULTIPLIER_SCALE } from '../limbo/index.js';

/** Wall-clock milliseconds per tick. 100ms is smooth enough to animate against. */
export const TICK_MS = 100;

/**
 * Growth per second of elapsed time, as pysino had it: `(1 + 0.07) ** (seconds * 4)`.
 * Kept identical so the curve has the same feel - tense early, vicious late.
 */
const GROWTH_BASE = 1.07;
const GROWTH_EXPONENT_PER_SECOND = 4;

/** The multiplier at a given tick, in hundredths. Never below 1.00x. */
export function multiplierAtTick(tick: number): number {
  if (tick <= 0) return MULTIPLIER_SCALE;
  const seconds = (tick * TICK_MS) / 1000;
  const raw = GROWTH_BASE ** (seconds * GROWTH_EXPONENT_PER_SECOND);
  return Math.max(MULTIPLIER_SCALE, Math.floor(raw * MULTIPLIER_SCALE));
}

/**
 * The first tick at which the curve has reached `value` hundredths.
 *
 * Derived by inverting the growth curve, then corrected by stepping - the closed form
 * can land a tick either side of the floor boundary, and the whole point of this module
 * is that the boundary is exact.
 */
export function tickReaching(value: number): number {
  if (value <= MULTIPLIER_SCALE) return 0;
  const seconds =
    Math.log(value / MULTIPLIER_SCALE) /
    (Math.log(GROWTH_BASE) * GROWTH_EXPONENT_PER_SECOND);
  let tick = Math.max(0, Math.floor((seconds * 1000) / TICK_MS) - 2);
  while (multiplierAtTick(tick) < value) tick += 1;
  return tick;
}

/**
 * The first tick at which the curve has passed `crashPoint` - i.e. the tick the round
 * dies on. Strictly *past*, so a player who grabs a multiplier equal to the crash point
 * is paid: see `winsAt` for why that strictness is load-bearing.
 */
export function crashTickFor(crashPoint: number): number {
  let tick = tickReaching(crashPoint);
  while (multiplierAtTick(tick) <= crashPoint) tick += 1;
  return tick;
}

/**
 * Whether taking `value` hundredths wins, given the round's crash point.
 *
 * This - not the tick grid - is what decides a payout, and the difference is a real
 * 1% of house edge. `P(crashPoint >= v) = (1 - edge) / (v / 100)` exactly, so paying
 * `v` on that event makes the expected return exactly `1 - edge` at *every* target,
 * which is the property that makes the game fair rather than merely random.
 *
 * Letting ticks arbitrate instead breaks it twice over: the curve only takes certain
 * discrete values, so a target of 2.00x would be settled against the 2.02x the tick
 * actually reached; and a crash point that floors to exactly 1.00x (which happens with
 * probability 2/101, not `edge`, because of that same flooring) would take the whole
 * stake instead of pushing.
 */
export const winsAt = (crashPoint: number, value: number): boolean => value <= crashPoint;

export type CrashState = 'running' | 'cashed' | 'crashed';

export interface CrashRound {
  bet: number;
  /** In hundredths. Secret until the round ends. */
  crashPoint: number;
  crashTick: number;
  /** In hundredths, or null for manual play. */
  autoCashOut: number | null;
  state: CrashState;
  /** Tick the player cashed out on, if they did. */
  cashedTick: number | null;
  cashedMultiplier: number | null;
}

export interface CrashResult {
  payout: number;
  multiplier: number;
  detail: {
    crashPoint: number;
    cashedMultiplier: number | null;
    won: boolean;
  };
}

/** Start a round. The crash point is drawn now and must not leave the server. */
export function startCrash(
  bet: number,
  draw: FairSource,
  autoCashOut: number | null = null,
  edge = HOUSE_EDGE,
): CrashRound {
  const crashPoint = drawMultiplier(draw, edge);
  return {
    bet,
    crashPoint,
    crashTick: crashTickFor(crashPoint),
    autoCashOut,
    state: 'running',
    cashedTick: null,
    cashedMultiplier: null,
  };
}

/**
 * Resolve a round as of `tick`, honouring an auto cash-out that fell earlier.
 *
 * Auto cash-out is evaluated here rather than by the client so that a disconnect cannot
 * cost a player a target they set before the round began.
 */
export function resolveAt(round: CrashRound, tick: number): CrashRound {
  if (round.state !== 'running') return round;

  const auto = round.autoCashOut;
  if (auto !== null && winsAt(round.crashPoint, auto)) {
    const autoTick = tickReaching(auto);
    if (tick >= autoTick) {
      // Paid at exactly the target, not at whatever the tick grid overshot to. Asking
      // for 2.00x and being handed 2.02x is free money the maths never budgeted for.
      return { ...round, state: 'cashed', cashedTick: autoTick, cashedMultiplier: auto };
    }
  }

  if (tick >= round.crashTick) return { ...round, state: 'crashed' };
  return round;
}

/**
 * Cash out manually at `tick`. Losing the race is not an error - it is a crashed round,
 * which is exactly what the player risked.
 */
export function cashOutAt(round: CrashRound, tick: number): CrashRound {
  const settled = resolveAt(round, tick);
  if (settled.state !== 'running') return settled;

  const value = multiplierAtTick(tick);
  if (!winsAt(settled.crashPoint, value)) return { ...settled, state: 'crashed' };
  return { ...settled, state: 'cashed', cashedTick: tick, cashedMultiplier: value };
}

export function settle(round: CrashRound): CrashResult {
  const won = round.state === 'cashed' && round.cashedMultiplier !== null;
  const multiplier = won ? (round.cashedMultiplier as number) / MULTIPLIER_SCALE : 0;
  return {
    payout: won ? payoutFor(round.bet, multiplier) : 0,
    multiplier,
    detail: {
      crashPoint: round.crashPoint,
      cashedMultiplier: round.cashedMultiplier,
      won,
    },
  };
}

export const CRASH_HOUSE_EDGE = HOUSE_EDGE;
