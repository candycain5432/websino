/**
 * Symbols, paytable and reel strips for Golden Reels.
 *
 * The numbers here are the genuinely valuable part of pysino's slot machine: the
 * paytable and the per-reel weights were tuned *together* against a 200k-spin sample
 * to land near 95% RTP with a roughly 48% hit rate. They are ported verbatim, because
 * re-tuning from scratch would mean re-deriving a balance that already works.
 */

export const ROWS = 3;
export const REELS = 5;

export const CHERRY = 'cherry';
export const LEMON = 'lemon';
export const BELL = 'bell';
export const HORSESHOE = 'horseshoe';
export const DIAMOND = 'diamond';
export const CROWN = 'crown';
export const SEVEN = 'seven';
export const WILD = 'wild';
export const SCATTER = 'scatter';

export const SYMBOLS = [
  CHERRY, LEMON, BELL, HORSESHOE, DIAMOND, CROWN, SEVEN, WILD, SCATTER,
] as const;

/** Not `Symbol` - that name is taken by a JS global and shadowing it is a trap. */
export type SlotSymbol = (typeof SYMBOLS)[number];

export const SYMBOL_GLYPHS: Record<SlotSymbol, string> = {
  [CHERRY]: '❀',
  // pysino used a diamond here too, so lemon and diamond differed only by colour -
  // unreadable at a glance and worse than unreadable if you cannot see the colour.
  [LEMON]: '◉',
  [BELL]: '♛',
  [HORSESHOE]: '∩',
  [DIAMOND]: '♦',
  [CROWN]: '♗',
  [SEVEN]: '7',
  [WILD]: 'W',
  [SCATTER]: '★',
};

export const SYMBOL_NAMES: Record<SlotSymbol, string> = {
  [CHERRY]: 'Cherry',
  [LEMON]: 'Lemon',
  [BELL]: 'Bell',
  [HORSESHOE]: 'Horseshoe',
  [DIAMOND]: 'Diamond',
  [CROWN]: 'Crown',
  [SEVEN]: 'Lucky 7',
  [WILD]: 'Wild',
  [SCATTER]: 'Scatter',
};

/** Pay for 3, 4 and 5 of a kind, as a multiple of the *line* bet. */
export const PAYTABLE: Record<string, readonly [number, number, number]> = {
  [CHERRY]: [5, 20, 60],
  [LEMON]: [5, 20, 60],
  [BELL]: [10, 40, 125],
  [HORSESHOE]: [12, 50, 175],
  [DIAMOND]: [20, 75, 300],
  [CROWN]: [30, 125, 600],
  [SEVEN]: [60, 300, 1500],
  [WILD]: [125, 750, 5000],
};

/** Scatters pay a multiple of the *total* bet and ignore paylines entirely. */
export const SCATTER_PAYS: Record<number, number> = { 3: 4, 4: 20, 5: 150 };
export const FREE_SPIN_AWARD: Record<number, number> = { 3: 10, 4: 15, 5: 25 };
export const FREE_SPIN_MULTIPLIER = 2;

/** Row touched on each of the five reels, for all twenty lines. */
export const PAYLINES: ReadonlyArray<readonly number[]> = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1], [0, 1, 1, 1, 0], [2, 1, 1, 1, 2], [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1], [0, 0, 1, 0, 0], [2, 2, 1, 2, 2], [1, 1, 0, 1, 1],
  [1, 1, 2, 1, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2], [0, 2, 0, 2, 0],
];

export const LINE_COUNT = PAYLINES.length;

/**
 * Per-reel symbol weights. The outer reels are stingier with high symbols, which is
 * what keeps five-of-a-kind rare without flattening the rest of the paytable.
 */
export const REEL_WEIGHTS: ReadonlyArray<Record<string, number>> = [
  { cherry: 32, lemon: 32, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 4, scatter: 5 },
  { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
  { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
  { cherry: 28, lemon: 28, bell: 24, horseshoe: 20, diamond: 16, crown: 12, seven: 8, wild: 6, scatter: 5 },
  { cherry: 36, lemon: 36, bell: 26, horseshoe: 22, diamond: 16, crown: 12, seven: 8, wild: 4, scatter: 5 },
];

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

export const REEL_STRIPS: ReadonlyArray<readonly string[]> = REEL_WEIGHTS.map(buildStrip);
