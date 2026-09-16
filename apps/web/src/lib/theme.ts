/**
 * Which room the casino is decorated as.
 *
 * A theme is a `data-theme` attribute on `<html>` and nothing else - `styles/themes.css`
 * re-points a dozen colour tokens under that selector, and every surface, material and
 * glow in the app is derived from those. So this module has no colours in it at all: its
 * whole job is deciding *which* name is on the attribute and making sure the answer
 * survives a reload, a sign-in on another machine, and the gap between the two.
 *
 * Three places remember the choice, in order of authority:
 *
 *   **The account**, for a signed-in player. It is the only copy that follows them to
 *   another browser, so it wins whenever it disagrees.
 *
 *   **`localStorage`**, as a cache. It is read *synchronously at boot*, before React has
 *   mounted and long before the account has answered - which is the entire reason it
 *   exists. Without it every load would paint the default green for a few hundred
 *   milliseconds and then snap to the chosen theme, and a flash of the wrong colour on
 *   every page load is worse than not offering themes at all.
 *
 *   **Practice mode** has only the cache, because it has no account. That is the same
 *   rule the practice wallet follows: local things stay local.
 */

export const THEMES = [
  {
    id: 'emerald',
    name: 'Emerald',
    blurb: 'Green felt and gold. The house default.',
    swatch: ['#165c42', '#0c3627', '#d4af37'],
  },
  {
    id: 'midnight',
    name: 'Midnight Neon',
    blurb: 'Near-black, lit in cyan.',
    swatch: ['#10304a', '#05070e', '#2fd8e0'],
  },
  {
    id: 'velvet',
    name: 'Red Velvet',
    blurb: 'Crimson cloth, mahogany and brass.',
    swatch: ['#7a1526', '#120507', '#e0a94a'],
  },
  {
    id: 'royal',
    name: 'Royal',
    blurb: 'Deep indigo trimmed in old silver.',
    swatch: ['#2a2470', '#090718', '#c8cfe8'],
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    blurb: 'Graphite, and one line of gold.',
    swatch: ['#232427', '#0a0a0b', '#d9b871'],
  },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'emerald';

const STORAGE_KEY = 'websino.theme';

/** Whether a string off the wire or out of storage is a theme this build actually has. */
export function isTheme(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
}

/**
 * Put a theme on the document.
 *
 * The default is written out as an attribute rather than left absent, so that "no theme
 * chosen" and "the green one chosen" are the same state in the DOM. The alternative is a
 * selector that has to match both `:root` and `:root[data-theme='emerald']`, which is one
 * more thing to get wrong every time a token moves.
 */
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows and blocked site data. The theme still applies for this page; it
    // just will not be remembered, which is a smaller failure than not rendering.
  }
}

/** The cached choice, for painting the first frame before anything has been fetched. */
export function cachedTheme(): ThemeId {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
