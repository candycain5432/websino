/**
 * The cabinets on the floor.
 *
 * A slot machine is *data*: symbols, a paytable, paylines, per-reel weights and the
 * free-spin rules. Everything in `index.ts` is the shared mechanism that reads one, so
 * adding a machine is adding a record here rather than forking the engine - which is
 * what "variety pack" has to mean if the tuning of the original is to stay intact.
 *
 * Golden Reels is the machine pysino shipped, values unchanged. Its exact return is
 * 94.7374% and a test still pins it to four decimals, so this refactor is provably not
 * a re-tune of the machine that already worked.
 *
 * **Every machine's return is computable in closed form** - see `exactReturn` below -
 * so a new cabinet cannot be added without knowing what it pays. That matters more here
 * than anywhere else in the casino: a slot's economics live entirely in numbers nobody
 * can eyeball, and simulation is far too noisy to check them (the bonus tail dominates).
 */

export const ROWS = 3;
export const REELS = 5;

export const WILD = 'wild';
export const SCATTER = 'scatter';

export interface SlotMachine {
  id: string;
  name: string;
  /** One line of character, for the picker. */
  blurb: string;
  /** Every symbol this cabinet uses, including wild and scatter. */
  symbols: readonly string[];
  glyphs: Record<string, string>;
  names: Record<string, string>;
  /** Pay for 3, 4 and 5 of a kind, as a multiple of the *line* bet. */
  paytable: Record<string, readonly [number, number, number]>;
  /** Row touched on each reel, one entry per line. */
  paylines: ReadonlyArray<readonly number[]>;
  /** Per-reel symbol weights, expanded into strips by `buildStrip`. */
  reelWeights: ReadonlyArray<Record<string, number>>;
  /** Scatters pay a multiple of the *total* bet and ignore paylines. */
  scatterPays: Record<number, number>;
  freeSpinAward: Record<number, number>;
  freeSpinMultiplier: number;
  /** Accent colour for the cabinet, as a CSS custom-property reference. */
  accent: string;
}

/**
 * Expand a weight table into a physical reel strip.
 *
 * Copies of each symbol are spread as evenly as the weights allow rather than laid
 * down in blocks. That matters more than it looks: a reel shows three *consecutive*
 * strip positions at once, so a blocked strip would show three of a kind on nearly
 * every spin and the paytable tuning would be meaningless.
 */
export function buildStrip(weights: Record<string, number>): string[] {
  const symbols = Object.keys(weights);
  const placed: Record<string, number> = {};
  for (const s of symbols) placed[s] = 0;

  const total = symbols.reduce((sum, s) => sum + (weights[s] as number), 0);
  const strip: string[] = [];

  for (let i = 0; i < total; i += 1) {
    // Extend with whichever symbol is furthest behind its share. Ties break on the
    // symbol name so the strip is a pure function of the weights.
    let best: string | undefined;
    let bestRatio = Infinity;
    for (const s of symbols) {
      const want = weights[s] as number;
      if ((placed[s] as number) >= want) continue;
      const ratio = ((placed[s] as number) + 0.5) / want;
      if (ratio < bestRatio || (ratio === bestRatio && best !== undefined && s < best)) {
        best = s;
        bestRatio = ratio;
      }
    }
    const chosen = best as string;
    strip.push(chosen);
    placed[chosen] = (placed[chosen] as number) + 1;
  }
  return strip;
}

/** Strips are derived from weights, and derived once - they never change at runtime. */
const stripCache = new WeakMap<SlotMachine, ReadonlyArray<readonly string[]>>();

export function stripsOf(machine: SlotMachine): ReadonlyArray<readonly string[]> {
  let strips = stripCache.get(machine);
  if (!strips) {
    strips = machine.reelWeights.map(buildStrip);
    stripCache.set(machine, strips);
  }
  return strips;
}

export const lineCountOf = (machine: SlotMachine): number => machine.paylines.length;

// ------------------------------------------------------------------ the cabinets --

/** Twenty lines, laid out so every row and both diagonals are covered. */
const TWENTY_LINES: ReadonlyArray<readonly number[]> = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1], [0, 0, 1, 0, 0], [2, 2, 1, 2, 2], [1, 1, 0, 1, 1],
  [1, 1, 2, 1, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2], [0, 2, 0, 2, 0],
];

/** The first ten of the twenty - fewer lines is what makes a cabinet swingy. */
const TEN_LINES: ReadonlyArray<readonly number[]> = TWENTY_LINES.slice(0, 10);

/** Twenty-five: the twenty plus five more zig-zags, for a cabinet that pays often. */
const TWENTY_FIVE_LINES: ReadonlyArray<readonly number[]> = [
  ...TWENTY_LINES,
  [1, 0, 2, 0, 1], [1, 2, 0, 2, 1], [0, 2, 2, 2, 0], [2, 0, 0, 0, 2], [0, 2, 1, 0, 2],
];

/**
 * Golden Reels - the machine pysino shipped.
 *
 * Paytable and weights ported verbatim. They were tuned *together* against a 200k-spin
 * sample to land near 95% with a roughly 48% hit rate, and re-deriving a balance that
 * already works would be a waste of a good tuning.
 */
export const GOLDEN_REELS: SlotMachine = {
  id: 'golden',
  name: 'Golden Reels',
  blurb: 'The house classic · 20 lines, balanced',
  symbols: ['cherry', 'lemon', 'bell', 'horseshoe', 'diamond', 'crown', 'seven', WILD, SCATTER],
  glyphs: {
    cherry: '❀',
    // pysino used a diamond here too, so lemon and diamond differed only by colour -
    // unreadable at a glance and worse than unreadable if you cannot see the colour.
    lemon: '◉',
    bell: '♛',
    horseshoe: '∩',
    diamond: '♦',
    crown: '♗',
    seven: '7',
    [WILD]: 'W',
    [SCATTER]: '★',
  },
  names: {
    cherry: 'Cherry',
    lemon: 'Lemon',
    bell: 'Bell',
    horseshoe: 'Horseshoe',
    diamond: 'Diamond',
    crown: 'Crown',
    seven: 'Lucky 7',
    [WILD]: 'Wild',
    [SCATTER]: 'Scatter',
  },
  paytable: {
    cherry: [5, 20, 60],
    lemon: [5, 20, 60],
    bell: [10, 40, 125],
    horseshoe: [12, 50, 175],
    diamond: [20, 75, 300],
    crown: [30, 125, 600],
    seven: [60, 300, 1500],
    [WILD]: [125, 750, 5000],
  },
  paylines: TWENTY_LINES,
  reelWeights: [
    { cherry: 32, lemon: 32, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 4, scatter: 5 },
    { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
    { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
    { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
    { cherry: 36, lemon: 36, bell: 26, horseshoe: 22, diamond: 16, crown: 12, seven: 8, wild: 4, scatter: 5 },
  ],
  scatterPays: { 3: 4, 4: 20, 5: 150 },
  freeSpinAward: { 3: 10, 4: 15, 5: 25 },
  freeSpinMultiplier: 2,
  accent: 'var(--gold)',
};

/**
 * Neon Nights - ten lines, and most of the money in the top of the paytable.
 *
 * Half the lines of Golden Reels and a steeper table, so it pays less often and pays
 * more when it does. The wild is rarer and worth far more, which is where the variance
 * comes from rather than from a bigger bonus.
 */
export const NEON_NIGHTS: SlotMachine = {
  id: 'neon',
  name: 'Neon Nights',
  blurb: 'Ten lines, long odds, big top end',
  symbols: ['circuit', 'visor', 'moto', 'katana', 'skyline', 'ace', WILD, SCATTER],
  glyphs: {
    circuit: '⌘',
    visor: '◕',
    moto: '⌁',
    katana: '†',
    skyline: '⌂',
    ace: 'A',
    [WILD]: 'W',
    [SCATTER]: '✦',
  },
  names: {
    circuit: 'Circuit',
    visor: 'Visor',
    moto: 'Moto',
    katana: 'Katana',
    skyline: 'Skyline',
    ace: 'Neon Ace',
    [WILD]: 'Wild',
    [SCATTER]: 'Scatter',
  },
  /*
   * Tuned against `exactReturn`, not by feel.
   *
   * The shape was chosen first - steep, top-heavy - and then every pay was scaled until
   * the cabinet returned close to what the classic does, because RTP is linear in a
   * uniform scaling of the paytable. Plain rounding pushed the two new cabinets 1.5
   * points apart in opposite directions, with the swingy one paying *less*, which is
   * backwards; snapping each pay to a ladder of numbers a paytable plausibly prints
   * (5, 25, 125, 600 rather than 34, 236, 559) and sweeping the scale for the best fit
   * lands every cabinet within a point of the others. The exact figures are pinned.
   */
  paytable: {
    circuit: [2, 10, 35],
    visor: [4, 18, 60],
    moto: [6, 30, 120],
    katana: [10, 60, 250],
    skyline: [25, 125, 600],
    ace: [60, 325, 1600],
    [WILD]: [125, 900, 6000],
  },
  paylines: TEN_LINES,
  reelWeights: [
    { circuit: 34, visor: 28, moto: 22, katana: 16, skyline: 10, ace: 6, wild: 3, scatter: 4 },
    { circuit: 32, visor: 28, moto: 22, katana: 16, skyline: 10, ace: 6, wild: 4, scatter: 4 },
    { circuit: 32, visor: 28, moto: 22, katana: 16, skyline: 10, ace: 6, wild: 4, scatter: 4 },
    { circuit: 32, visor: 28, moto: 22, katana: 16, skyline: 10, ace: 6, wild: 4, scatter: 4 },
    { circuit: 36, visor: 30, moto: 22, katana: 16, skyline: 10, ace: 6, wild: 3, scatter: 4 },
  ],
  scatterPays: { 3: 3, 4: 15, 5: 125 },
  freeSpinAward: { 3: 12, 4: 18, 5: 30 },
  freeSpinMultiplier: 3,
  accent: 'var(--purple)',
};

/**
 * Emerald Rush - twenty-five lines and a flat table, so something lands most spins.
 *
 * The opposite tuning to Neon Nights: more lines, cheaper symbols, a common wild and a
 * small bonus. The top prize is modest on purpose - this cabinet is meant to tick over,
 * not to hand anyone a fortune.
 */
export const EMERALD_RUSH: SlotMachine = {
  id: 'emerald',
  name: 'Emerald Rush',
  blurb: 'Twenty-five lines, something lands most spins',
  symbols: ['clover', 'fern', 'beetle', 'jade', 'idol', 'emerald', WILD, SCATTER],
  glyphs: {
    clover: '✿',
    fern: '❦',
    beetle: '❖',
    jade: '❄',
    idol: '⚱',
    emerald: '◈',
    [WILD]: 'W',
    [SCATTER]: '☘',
  },
  names: {
    clover: 'Clover',
    fern: 'Fern',
    beetle: 'Beetle',
    jade: 'Jade',
    idol: 'Idol',
    emerald: 'Emerald',
    [WILD]: 'Wild',
    [SCATTER]: 'Scatter',
  },
  /* Same tuning method as Neon Nights; see the note there. */
  paytable: {
    clover: [3, 10, 25],
    fern: [4, 15, 35],
    beetle: [5, 18, 50],
    jade: [8, 25, 75],
    idol: [12, 45, 140],
    emerald: [25, 100, 300],
    [WILD]: [50, 200, 800],
  },
  paylines: TWENTY_FIVE_LINES,
  reelWeights: [
    { clover: 26, fern: 24, beetle: 22, jade: 18, idol: 13, emerald: 9, wild: 7, scatter: 5 },
    { clover: 24, fern: 24, beetle: 22, jade: 18, idol: 13, emerald: 9, wild: 8, scatter: 5 },
    { clover: 24, fern: 24, beetle: 22, jade: 18, idol: 13, emerald: 9, wild: 8, scatter: 5 },
    { clover: 24, fern: 24, beetle: 22, jade: 18, idol: 13, emerald: 9, wild: 8, scatter: 5 },
    { clover: 28, fern: 26, beetle: 22, jade: 18, idol: 13, emerald: 9, wild: 7, scatter: 5 },
  ],
  scatterPays: { 3: 3, 4: 12, 5: 60 },
  freeSpinAward: { 3: 8, 4: 12, 5: 18 },
  freeSpinMultiplier: 2,
  accent: 'var(--win)',
};

export const MACHINES: readonly SlotMachine[] = [GOLDEN_REELS, NEON_NIGHTS, EMERALD_RUSH];

export function machineById(id: string): SlotMachine {
  const found = MACHINES.find((m) => m.id === id);
  if (!found) throw new Error(`unknown slot machine: ${id}`);
  return found;
}
