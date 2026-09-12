/**
 * A guard against the bug that broke the shared-table screen on its first run.
 *
 * The client ships one stylesheet. Every class in every `.css` file lands in the same
 * global namespace, so a new screen that reuses a class name another screen already
 * owns inherits its rules silently - no error, no warning, just a layout that makes no
 * sense. `.felt` was roulette's betting grid; the tables screen called its table felt
 * too, and got a two-column grid with named areas it had never asked for.
 *
 * That is not a mistake worth making twice, and it is trivially checkable: a class
 * defined in two different files is either a collision or a rule that belongs in
 * `base.css`. Either way it should be a decision, not an accident.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Files whose classes are meant to be shared by everything. */
const SHARED = ['styles/base.css', 'styles/tokens.css'];

function cssFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full, `${prefix}${name}/`);
    return name.endsWith('.css') ? [`${prefix}${name}`] : [];
  });
}

/**
 * The classes a file *claims* - the blocks it declares itself the owner of.
 *
 * A claim is a rule whose first compound selector is a single unqualified class:
 * `.baize { ... }` or `.pseat__name { ... }`. Anything narrower is a contextual tweak
 * rather than an ownership claim, and those are fine to share:
 *
 *   `.seat.is-you`                    - styles a state of someone else's block
 *   `.bj__actions .btn.is-hinted`     - styles a shared button inside your own block
 *   `.bet__chip:hover .chip`          - styles a nested component in context
 *
 * Only the first kind can silently hand a new screen a layout it never asked for, so
 * only the first kind is what this counts.
 */
function claimedClasses(css: string): Set<string> {
  const rules = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Keep @media contents by dropping only the at-rule preludes and any nesting braces
    // they introduce; selector text is all this needs.
    .replace(/@[a-z-]+[^{;]*[{;]/gi, ' ');

  const claims = new Set<string>();
  for (const match of rules.matchAll(/([^{}]+)\{/g)) {
    for (const selector of (match[1] ?? '').split(',')) {
      // The first compound: everything up to the first combinator.
      const first = selector.trim().split(/[\s>+~]+/)[0] ?? '';
      // Pseudo-classes can carry selectors of their own - `:not(.x)` - and those are
      // qualifiers, so they have to be counted before being stripped.
      const classes = first.match(/\.(-?[A-Za-z_][\w-]*)/g) ?? [];
      if (classes.length !== 1) continue;
      const name = (classes[0] ?? '').slice(1);
      // A state modifier is never a block; it only ever qualifies one.
      if (/^(is|has)-/.test(name)) continue;
      // An element or id at the head means the class is not the subject.
      if (/^[A-Za-z#[]/.test(first)) continue;
      claims.add(name);
    }
  }
  return claims;
}

describe('the global stylesheet', () => {
  const files = cssFiles(SRC).filter((file) => !SHARED.includes(file));

  it('has every block claimed by exactly one file', () => {
    const owners = new Map<string, string[]>();
    for (const file of files) {
      for (const name of claimedClasses(readFileSync(join(SRC, file), 'utf8'))) {
        owners.set(name, [...(owners.get(name) ?? []), file]);
      }
    }

    const collisions = [...owners]
      .filter(([, where]) => where.length > 1)
      .map(([name, where]) => `.${name} is claimed by ${where.join(' and ')}`);

    expect(collisions).toEqual([]);
  });

  it('recognises a claim, and would have caught the collision it exists for', () => {
    // The exact shape of the original bug: two files, both claiming `.felt`.
    expect(claimedClasses('.felt { display: grid; }')).toContain('felt');
    expect(claimedClasses('.felt__seats, .felt__middle { gap: 1px; }'))
      .toEqual(new Set(['felt__seats', 'felt__middle']));

    // And the shapes that are not claims, which is what makes the check usable.
    expect(claimedClasses('.seat.is-you { color: red; }').size).toBe(0);
    expect(claimedClasses('.bj__actions .btn.is-hinted { color: red; }'))
      .toEqual(new Set(['bj__actions']));
    expect(claimedClasses('.is-win { color: green; }').size).toBe(0);
    expect(claimedClasses('.pseat:hover:not(:disabled) { color: red; }'))
      .toEqual(new Set(['pseat']));
    expect(claimedClasses('input[type="range"] { accent-color: gold; }').size).toBe(0);

    // Inside a media query a claim still counts - that is where a collision hides best.
    expect(claimedClasses('@media (width <= 30rem) { .baize__seats { gap: 0; } }'))
      .toContain('baize__seats');
  });

  it('found the stylesheets it was meant to check', () => {
    // Otherwise a moved directory turns the check above into a test of nothing.
    expect(files.length).toBeGreaterThan(8);
    expect(files).toContain('screens/Tables.css');
    expect(files).toContain('games/RouletteGame.css');
  });
});
