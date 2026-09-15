/**
 * What happens when you win.
 *
 * Nothing did. Every game on the floor settled a winning round by changing a number from
 * grey to green, and a casino that does not react when you win is the single clearest tell
 * that nobody finished it - the whole product exists for that half-second and it was the
 * quietest moment on the screen.
 *
 * It lives in `GameShell` rather than in each game for the obvious reason and one less
 * obvious one: every solo game already reports its rounds to the shell as `HistoryEntry`,
 * so there is exactly one place that knows a round was won, and hooking it there means a
 * game added next year celebrates without being told to. A game that wanted a *different*
 * celebration would have to opt out, which is the right way round.
 *
 * The size of it is taken from what the round paid against what it cost. A 60x hit and a
 * coin back on a push should not look the same, and the thing the eye actually reads is
 * how much stuff there is - not how long it lasts or how bright it is.
 */

import { useMemo } from 'react';

import type { HistoryEntry } from './GameShell.js';
import './Celebration.css';

/** How many pieces each band throws. Past about fifty it stops reading as more. */
const SMALL = 14;
const GOOD = 26;
const BIG = 46;

export function Celebration({ win, stake }: { win: HistoryEntry | null; stake: number }) {
  /*
   * Keyed on the round, so the burst is rebuilt - and therefore replayed - once per win.
   *
   * Without the key React would keep the same elements across rounds and the animation,
   * having already finished, would never run again: the first win of a session would be
   * celebrated and none of the rest would.
   */
  const id = win?.id ?? 0;
  const bits = useMemo(() => {
    if (!win) return [];
    const ratio = win.net / Math.max(1, stake);
    const count = ratio >= 8 ? BIG : ratio >= 1.5 ? GOOD : SMALL;
    return Array.from({ length: count }, (_, i) => {
      /*
       * Sprayed upwards, in a fan rather than a circle.
       *
       * Angles are spread across the upper half only, because the board's bottom edge is
       * where the controls and the status line are - pieces thrown downwards spend their
       * whole life behind something. The `i * 2.3` is there to stop the fan from being
       * visibly evenly spaced, which a straight division makes it.
       */
      const angle = Math.PI + (Math.PI * (i + 0.5)) / count + Math.sin(i * 2.3) * 0.12;
      const reach = 120 + (i % 7) * 34;
      return {
        x: Math.cos(angle) * reach,
        y: Math.sin(angle) * reach,
        kind: i % 3,
        delay: (i % 6) * 38,
        spin: i % 2 === 0 ? 1 : -1,
      };
    });
  }, [id, stake, win]);

  if (bits.length === 0) return null;

  return (
    <div className="burst" key={id} aria-hidden="true">
      {bits.map((bit, i) => (
        <span
          key={i}
          className={`burst__bit burst__bit--${bit.kind}`}
          style={{
            '--x': `${bit.x.toFixed(1)}px`,
            '--y': `${bit.y.toFixed(1)}px`,
            '--spin': `${bit.spin * 420}deg`,
            animationDelay: `${bit.delay}ms`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
