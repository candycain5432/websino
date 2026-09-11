/**
 * Regenerates test/vectors.json.
 *
 * Run deliberately, never automatically:  npx tsx packages/fair/test/generate-vectors.ts
 * Moving a vector means outcomes changed for every player, which is a breaking change
 * and must come with a `fairVersion` bump.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { commit, FairStream } from '../src/index.js';

const CASES = [
  { serverSeed: 'a'.repeat(64), clientSeed: 'websino', nonce: 0 },
  { serverSeed: 'a'.repeat(64), clientSeed: 'websino', nonce: 1 },
  { serverSeed: '0123456789abcdef'.repeat(4), clientSeed: 'player-one', nonce: 42 },
  { serverSeed: 'f'.repeat(64), clientSeed: 'unicode-✓-seed', nonce: 7 },
];

const vectors = CASES.map((seed) => {
  const floats = new FairStream(seed);
  const uints = new FairStream(seed);
  const below37 = new FairStream(seed);
  const deck = new FairStream(seed);
  const mines = new FairStream(seed);

  return {
    ...seed,
    commitment: commit(seed.serverSeed),
    floats: Array.from({ length: 8 }, () => floats.nextFloat()),
    uint32s: Array.from({ length: 8 }, () => uints.nextUint32()),
    randBelow37: Array.from({ length: 12 }, () => below37.randBelow(37)),
    shuffled52: deck.shuffle(Array.from({ length: 52 }, (_, i) => i)),
    sample25of3: mines.sample(Array.from({ length: 25 }, (_, i) => i), 3),
  };
});

const out = { fairVersion: 1, spec: 'packages/fair/SPEC.md', vectors };
const path = fileURLToPath(new URL('./vectors.json', import.meta.url));
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${path}`);
