/**
 * A small picture of each game, for the lobby.
 *
 * The lobby used to be fifteen identical rectangles carrying a name and a tagline, which
 * is a *list* of games rather than a floor of them - you had to read it to use it, and
 * reading fifteen things is not how anyone picks a table. pysino's lobby got this right
 * by showing each game: a hand of cards for blackjack, a reel window reading 7-7-7 for
 * slots, a wheel for roulette. You find the one you want by recognising it.
 *
 * Three rules keep these honest rather than decorative:
 *
 *   **Every scene is drawn from the same tokens as the real game.** The blackjack preview
 *   is two actual `PlayingCard`s, not a picture of cards; the slots preview runs the same
 *   symbols the golden cabinet does; the roulette preview uses the same red, black and
 *   green the wheel does. So a change to the deck or the palette moves the lobby with it,
 *   and the preview cannot drift into advertising something the game does not look like.
 *
 *   **Every scene moves.** A still picture of a slot machine is a photograph of a slot
 *   machine, and fifteen photographs in a grid is a brochure. Reels turn, the wheel
 *   spins, the crash curve climbs and dies, the plinko ball falls - so the floor is alive
 *   before you have touched anything, which is the difference between a site that looks
 *   finished and one that looks like a wireframe with colours on it. All of it is
 *   transform and opacity, so it runs on the compositor and costs the main thread nothing.
 *
 *   **None of them carry state.** A preview never shows a balance, a real hand, or a live
 *   round; the motion is a loop, not a game. It is the cover of the game, and a cover that
 *   quietly went out of date would be worse than no cover at all.
 */

import { machineById, makeCard } from '@websino/engine';

import { PlayingCard } from './PlayingCard.js';
import { SuitGlyph } from './SuitGlyph.js';
import './GamePreview.css';

/** Engine ranks are 0-indexed from the two, so the ace is 12 and the jack is 9. */
const ACE = 12;
const KING = 11;
const QUEEN = 10;
const JACK = 9;
const TEN = 8;
const SPADE = 0;
const HEART = 1;
const DIAMOND = 2;
const CLUB = 3;

export function GamePreview({ game }: { game: string }) {
  return (
    <span className={`gp gp--${game}`} aria-hidden="true">
      {/* The scene is scaled by whatever is showing it, so one drawing serves every size. */}
      <span className="gp__scene">{SCENES[game]?.() ?? <Fallback />}</span>
    </span>
  );
}

/**
 * The reel strip on the slots tile.
 *
 * Four symbols, printed twice. The strip travels exactly half its own height, so the
 * frame it ends on is pixel-identical to the frame it started on and the loop has no
 * seam - the same trick the real machine's reel uses, and the reason this can run
 * forever without a single line of JavaScript watching it.
 */
function ReelStrip({ reel }: { reel: number }) {
  const machine = machineById('golden');
  const symbols = machine.symbols.slice(reel, reel + 4);
  return (
    <span className="gp__reel">
      <span
        className="gp__reel-strip"
        style={{ animationDuration: `${900 + reel * 260}ms` }}
      >
        {[...symbols, ...symbols].map((symbol, i) => (
          <span key={i} className={`gp__reel-cell slots__cell--${symbol}`}>
            {machine.glyphs[symbol] ?? symbol}
          </span>
        ))}
      </span>
    </span>
  );
}

const SCENES: Record<string, () => JSX.Element> = {
  // ------------------------------------------------------------------ cards --

  blackjack: () => (
    <span className="gp__hand">
      <PlayingCard card={makeCard(ACE, SPADE)} size="xs" />
      <PlayingCard card={makeCard(KING, HEART)} size="xs" />
    </span>
  ),

  holdem: () => (
    <span className="gp__hand gp__hand--table">
      <PlayingCard card={makeCard(ACE, HEART)} size="xs" />
      <PlayingCard card={makeCard(ACE, DIAMOND)} size="xs" />
      <span className="gp__stack">
        <span className="gp__disc gp__disc--3" />
        <span className="gp__disc gp__disc--2" />
        <span className="gp__disc gp__disc--1" />
      </span>
    </span>
  ),

  videopoker: () => (
    <span className="gp__hand gp__hand--five">
      {[
        makeCard(TEN, HEART), makeCard(JACK, HEART), makeCard(QUEEN, HEART),
        makeCard(KING, HEART), makeCard(ACE, HEART),
      ].map((card, i) => <PlayingCard key={i} card={card} size="xs" />)}
    </span>
  ),

  hilo: () => (
    <span className="gp__hand gp__hand--hilo">
      <PlayingCard card={makeCard(TEN, DIAMOND)} size="xs" />
      <span className="gp__guesses">
        <span className="gp__guess gp__guess--up">▲</span>
        <span className="gp__guess gp__guess--down">▼</span>
      </span>
    </span>
  ),

  tables: () => (
    <span className="gp__felt">
      <span className="gp__seats">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`gp__seat${i === 2 ? ' is-you' : ''}`}
            // The clock goes round the table, which is the whole shape of a shared hand.
            style={{ animationDelay: `${i * 520}ms` }}
          />
        ))}
      </span>
      <span className="gp__hand gp__hand--board">
        <PlayingCard card={makeCard(QUEEN, CLUB)} size="xs" />
        <PlayingCard card={makeCard(JACK, DIAMOND)} size="xs" />
        <PlayingCard card={makeCard(TEN, SPADE)} size="xs" />
      </span>
    </span>
  ),

  // ----------------------------------------------------------------- wheels --

  roulette: () => (
    <span className="gp__wheel">
      <span className="gp__pockets" />
      <span className="gp__wheel-rim" />
      <span className="gp__wheel-hub" />
      {/* The ball runs the other way round, as it does on the real one. */}
      <span className="gp__orbit"><span className="gp__ball" /></span>
    </span>
  ),

  wheel: () => (
    <span className="gp__wheel gp__wheel--fortune">
      <span className="gp__pockets" />
      <span className="gp__wheel-rim" />
      <span className="gp__wheel-hub" />
      <span className="gp__pointer" />
    </span>
  ),

  // ------------------------------------------------------------------ reels --

  slots: () => (
    <span className="gp__reels">
      {[0, 1, 2].map((reel) => <ReelStrip key={reel} reel={reel} />)}
    </span>
  ),

  // ------------------------------------------------------------- the curves --

  crash: () => (
    <svg className="gp__svg" viewBox="0 0 120 64" preserveAspectRatio="none">
      <defs>
        <linearGradient id="gp-crash" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--warn)" stopOpacity="0.15" />
          <stop offset="1" stopColor="var(--warn)" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <path className="gp__crash-fill" d="M4 60 C40 58 72 44 104 8 L104 60 Z" fill="url(#gp-crash)" />
      {/*
        * `pathLength="1"` normalises the dash maths.
        *
        * Without it the dash offset would have to be the curve's actual length in user
        * units - a number nobody can read off the `d` attribute and which changes the
        * moment the curve does. At 1, "draw the whole thing" is offset 0 and "draw none
        * of it" is offset 1, whatever shape it ends up being.
        */}
      <path
        className="gp__crash-line"
        d="M4 60 C40 58 72 44 104 8"
        pathLength="1"
        fill="none"
        stroke="var(--warn)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle className="gp__crash-head" cx="0" cy="0" r="4" fill="var(--gold-bright)" />
    </svg>
  ),

  limbo: () => (
    <span className="gp__limbo">
      <span className="gp__limbo-value numeric">12.40</span>
      <span className="gp__limbo-x">×</span>
    </span>
  ),

  // ------------------------------------------------------------------ grids --

  dice: () => (
    <span className="gp__track">
      <span className="gp__track-bar">
        <span className="gp__track-lose" />
        <span className="gp__track-win" />
      </span>
      <span className="gp__track-marker" />
      <span className="gp__track-scale">
        <span>0</span><span>50</span><span>100</span>
      </span>
    </span>
  ),

  mines: () => (
    <span className="gp__grid gp__grid--mines">
      {Array.from({ length: 16 }, (_, i) => {
        const gem = i === 5 || i === 10;
        const bomb = i === 9;
        return (
          <span
            key={i}
            className={`gp__cell${gem ? ' is-gem' : ''}${bomb ? ' is-bomb' : ''}`}
            // Turned over one after another, the way you actually play it.
            style={{ animationDelay: `${(i % 8) * 220}ms` }}
          >
            {gem ? '◆' : bomb ? '✹' : ''}
          </span>
        );
      })}
    </span>
  ),

  towers: () => (
    <span className="gp__tower">
      {[3, 2, 1, 0].map((row) => (
        <span key={row} className="gp__tower-row">
          {[0, 1, 2].map((tile) => (
            <span
              key={tile}
              // One climbed path, lit: the game is a route up, not a single pick.
              className={`gp__cell${row >= 2 && tile === (row === 3 ? 1 : 2) ? ' is-safe' : ''}`}
              // Bottom row first, so the light reads as a climb rather than a flicker.
              style={{ animationDelay: `${(3 - row) * 300}ms` }}
            />
          ))}
        </span>
      ))}
    </span>
  ),

  plinko: () => (
    <span className="gp__plinko">
      {[3, 4, 5, 6].map((count, row) => (
        <span key={row} className="gp__peg-row">
          {Array.from({ length: count }, (_, i) => <span key={i} className="gp__peg" />)}
        </span>
      ))}
      <span className="gp__buckets">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`gp__bucket${i === 0 || i === 4 ? ' is-hot' : ''}`} />
        ))}
      </span>
      <span className="gp__plinko-ball" />
    </span>
  ),

  bingo: () => (
    <span className="gp__bingo">
      <span className="gp__grid gp__grid--bingo">
        {Array.from({ length: 25 }, (_, i) => (
          <span
            key={i}
            className={`gp__cell${i === 12 ? ' is-free' : ''}${
              // A line through the middle row, which is what the game pays for.
              [10, 11, 13, 14].includes(i) ? ' is-marked' : ''
            }`}
            style={{ animationDelay: `${[10, 11, 13, 14].indexOf(i) * 340}ms` }}
          />
        ))}
      </span>
      <span className="gp__bingo-ball numeric">42</span>
    </span>
  ),
};

/** A game with no scene yet still gets the house mark rather than an empty hole. */
function Fallback() {
  return (
    <span className="gp__fallback">
      <SuitGlyph suit="spade" className="gp__fallback-suit" />
    </span>
  );
}
