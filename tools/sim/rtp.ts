/**
 * Long-run return-to-player simulation.
 *
 * The test suite runs a fast, fixed-seed version of this with tolerances wide enough
 * to stay stable in CI. This is the slow version: run it by hand (or nightly) when
 * changing payout maths, and check the numbers land where the design says they should.
 *
 *   npx tsx tools/sim/rtp.ts [rounds]
 */

import { FairStream } from '../../packages/fair/src/index.js';
import { HOUSE_EDGE } from '../../packages/engine/src/economy/chips.js';
import { dice, type DiceConfig } from '../../packages/engine/src/games/dice/index.js';
import { limbo } from '../../packages/engine/src/games/limbo/index.js';

const ROUNDS = Number(process.argv[2] ?? 200_000);
const BET = 100;
const SERVER_SEED = 'd'.repeat(64);

const stream = (nonce: number, tag: string): FairStream =>
  new FairStream({ serverSeed: SERVER_SEED, clientSeed: tag, nonce });

/** Standard error of the RTP estimate, for judging whether a deviation is real. */
function report(label: string, staked: number, returned: number, payouts: number[]): void {
  const rtp = returned / staked;
  const mean = payouts.reduce((a, b) => a + b, 0) / payouts.length;
  const variance = payouts.reduce((a, b) => a + (b - mean) ** 2, 0) / payouts.length;
  const stderr = Math.sqrt(variance / payouts.length) / BET;
  const sigma = Math.abs(rtp - (1 - HOUSE_EDGE)) / (stderr || 1);
  console.log(
    `  ${label.padEnd(22)} RTP ${rtp.toFixed(4)}  ` +
      `(target ${(1 - HOUSE_EDGE).toFixed(4)}, ${sigma.toFixed(1)}σ away)`,
  );
}

console.log(`\nSimulating ${ROUNDS.toLocaleString()} rounds per configuration\n`);

console.log('DICE');
const diceConfigs: DiceConfig[] = [
  { target: 5000, direction: 'over' },
  { target: 9000, direction: 'over' },
  { target: 9800, direction: 'over' },
  { target: 2000, direction: 'under' },
  { target: 7500, direction: 'under' },
];
for (const config of diceConfigs) {
  let staked = 0;
  let returned = 0;
  const payouts: number[] = [];
  for (let n = 0; n < ROUNDS; n += 1) {
    staked += BET;
    const p = dice.play(config, BET, stream(n, `dice:${config.target}:${config.direction}`)).payout;
    returned += p;
    payouts.push(p);
  }
  report(`${config.direction} ${(config.target / 100).toFixed(2)}`, staked, returned, payouts);
}

console.log('\nLIMBO');
for (const target of [150, 200, 500, 1000, 10_000]) {
  let staked = 0;
  let returned = 0;
  const payouts: number[] = [];
  for (let n = 0; n < ROUNDS; n += 1) {
    staked += BET;
    const p = limbo.play({ target }, BET, stream(n, `limbo:${target}`)).payout;
    returned += p;
    payouts.push(p);
  }
  report(`target ${(target / 100).toFixed(2)}x`, staked, returned, payouts);
}

console.log('');
