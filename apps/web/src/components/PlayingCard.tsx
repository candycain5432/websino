import type React from 'react';

import { cardName, isRed, rankLabel, rankOf, suitOf, type Card } from '@websino/engine';

import { SuitGlyph, SUIT_NAMES, type SuitName } from './SuitGlyph.js';
import './PlayingCard.css';

/**
 * A playing card as real DOM.
 *
 * pysino drew these pixel by pixel onto a canvas, so they were blurry when scaled and
 * invisible to a screen reader. These are elements: crisp at any size, flippable with a
 * CSS rotateY (the Python version faked exactly that with a horizontal squash), and they
 * carry their own accessible name.
 *
 * **The first version of this was the single thing that made the whole site look
 * amateur**, and it is worth being precise about why, because none of it was a bug. It
 * drew one enormous suit symbol in the middle of every card - so the seven of clubs and
 * the two of clubs differed only by a corner index - and the corner indices themselves
 * were set at 20% of the card's width, roughly double life size, with the bottom one
 * rotated 180 degrees. At small sizes the rotated glyphs read as upside-down mistakes
 * rather than as a card you could turn around, which is exactly what they are for.
 *
 * A real card is built from three things, all of them here:
 *
 *   **Indices** - small. Rank over suit, about 12% of the card's width, in the top-left
 *   and repeated rotated in the bottom-right so the card reads from either end when it
 *   is fanned in a hand. That is the entire reason they are duplicated, and it only
 *   works if they are small enough not to compete with the face.
 *
 *   **Pips** - the classic arrangement. Two through ten each have a fixed layout on a
 *   three-column, seven-row lattice that has not changed since the 15th century, and the
 *   pips below the midline are rotated, so the card is symmetrical under a half turn.
 *   `PIP_LAYOUT` below is that table.
 *
 *   **Courts and aces** - a different composition entirely. The ace gets one large
 *   ornamental pip; jack, queen and king get a mirrored two-up panel, which is how court
 *   cards have always been drawn and why they, too, survive being turned around.
 */

const RANK_ACE = 12;
const RANK_JACK = 9;

/** Fractional `[x, y]` positions within the card's pip field, top-left origin. */
type Pip = readonly [number, number];

const LEFT = 0.205;
const MID = 0.5;
const RIGHT = 0.795;

/** The seven lattice rows a pip may sit on. */
const ROW = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1] as const;

/**
 * Where the pips go, by rank, two through ten.
 *
 * Indexed by engine rank, so entry 0 is the two. These are the traditional layouts, not
 * an even distribution: the seven and eight hang a pip between the top pair and the
 * middle row rather than spacing everything equally, and the nine and ten use four rows
 * down each side instead of three. Spacing them evenly is the tell that a deck was
 * generated rather than drawn.
 */
const PIP_LAYOUT: readonly (readonly Pip[])[] = [
  // 2
  [[MID, ROW[0]], [MID, ROW[6]]],
  // 3
  [[MID, ROW[0]], [MID, ROW[3]], [MID, ROW[6]]],
  // 4
  [[LEFT, ROW[0]], [RIGHT, ROW[0]], [LEFT, ROW[6]], [RIGHT, ROW[6]]],
  // 5
  [[LEFT, ROW[0]], [RIGHT, ROW[0]], [MID, ROW[3]], [LEFT, ROW[6]], [RIGHT, ROW[6]]],
  // 6
  [
    [LEFT, ROW[0]], [RIGHT, ROW[0]],
    [LEFT, ROW[3]], [RIGHT, ROW[3]],
    [LEFT, ROW[6]], [RIGHT, ROW[6]],
  ],
  // 7 - the odd pip sits between the top pair and the middle row.
  [
    [LEFT, ROW[0]], [RIGHT, ROW[0]],
    [MID, 1.5 / 6],
    [LEFT, ROW[3]], [RIGHT, ROW[3]],
    [LEFT, ROW[6]], [RIGHT, ROW[6]],
  ],
  // 8 - and the eight mirrors it below.
  [
    [LEFT, ROW[0]], [RIGHT, ROW[0]],
    [MID, 1.5 / 6],
    [LEFT, ROW[3]], [RIGHT, ROW[3]],
    [MID, 4.5 / 6],
    [LEFT, ROW[6]], [RIGHT, ROW[6]],
  ],
  // 9 - four a side, one in the middle.
  [
    [LEFT, ROW[0]], [RIGHT, ROW[0]],
    [LEFT, ROW[2]], [RIGHT, ROW[2]],
    [MID, ROW[3]],
    [LEFT, ROW[4]], [RIGHT, ROW[4]],
    [LEFT, ROW[6]], [RIGHT, ROW[6]],
  ],
  // 10 - four a side, two down the centre.
  [
    [LEFT, ROW[0]], [RIGHT, ROW[0]],
    [MID, ROW[1]],
    [LEFT, ROW[2]], [RIGHT, ROW[2]],
    [LEFT, ROW[4]], [RIGHT, ROW[4]],
    [MID, ROW[5]],
    [LEFT, ROW[6]], [RIGHT, ROW[6]],
  ],
];

export function PlayingCard({
  card,
  faceUp = true,
  size = 'md',
  highlighted = false,
  dimmed = false,
  dealIndex = 0,
}: {
  /** Explicitly `undefined` is meaningful here: it is the face-down case. */
  card?: Card | undefined;
  faceUp?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  highlighted?: boolean;
  /** Folded, discarded, not held - drawn back rather than removed. */
  dimmed?: boolean;
  /**
   * Position in the hand, which staggers the deal animation.
   *
   * A dealer puts cards out one at a time, and two cards appearing in the same frame is
   * the single clearest tell that nothing was dealt - the hand simply *was*. Passing the
   * index makes a hand arrive card by card for the price of a CSS variable.
   *
   * The delay is capped at four cards in `PlayingCard.css`. Cards mount when they are
   * dealt, so a hit lands alone and takes its index's delay whether or not anything else
   * arrived with it; uncapped, the eighth card of a drawn-out hand would sit still for
   * half a second before appearing, which reads as lag rather than as dealing.
   */
  dealIndex?: number;
}) {
  const showFace = faceUp && card !== undefined;
  const suit: SuitName = showFace ? (SUIT_NAMES[suitOf(card)] as SuitName) : 'spade';
  const rank = showFace ? rankOf(card) : 0;

  const classes = [
    'card',
    `card--${size}`,
    showFace ? '' : 'card--down',
    highlighted ? 'card--highlighted' : '',
    dimmed ? 'card--dimmed' : '',
    showFace && isRed(card) ? 'card--red' : 'card--black',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role="img"
      aria-label={showFace ? cardName(card) : 'face down card'}
      style={{ '--deal-index': Math.min(dealIndex, 3) } as React.CSSProperties}
    >
      <div className="card__inner">
        {showFace ? (
          <>
            <Index label={rankLabel(card)} suit={suit} />
            <div className="card__field">
              {rank === RANK_ACE ? (
                <AceFace suit={suit} />
              ) : rank >= RANK_JACK ? (
                <CourtFace label={rankLabel(card)} suit={suit} />
              ) : (
                <Pips rank={rank} suit={suit} />
              )}
            </div>
            <Index label={rankLabel(card)} suit={suit} flipped />
          </>
        ) : (
          <span className="card__back" aria-hidden="true">
            <span className="card__back-emblem">
              <SuitGlyph suit="spade" className="card__back-suit" />
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Rank over suit, in a corner. Repeated rotated so the card reads from either end. */
function Index({
  label,
  suit,
  flipped = false,
}: {
  label: string;
  suit: SuitName;
  flipped?: boolean;
}) {
  return (
    <span className={`card__index ${flipped ? 'card__index--br' : 'card__index--tl'}`}>
      {/* `10` is the only two-character rank, and the only one that needs squeezing. */}
      <span className={`card__rank ${label === '10' ? 'card__rank--wide' : ''}`}>{label}</span>
      <SuitGlyph suit={suit} className="card__index-suit" />
    </span>
  );
}

function Pips({ rank, suit }: { rank: number; suit: SuitName }) {
  const layout = PIP_LAYOUT[rank] ?? [];
  return (
    <>
      {layout.map(([x, y], i) => (
        <span
          key={i}
          // Below the midline a pip is drawn upside down, which is what makes the whole
          // card symmetrical under a half turn.
          className={`card__pip ${y > 0.5 ? 'card__pip--inverted' : ''}`}
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
        >
          <SuitGlyph suit={suit} className="card__pip-suit" />
        </span>
      ))}
    </>
  );
}

/** One large pip on a ruled ground - the ace has been the showpiece of a deck forever. */
function AceFace({ suit }: { suit: SuitName }) {
  return (
    <span className="card__ace">
      <SuitGlyph suit={suit} className="card__ace-suit" />
    </span>
  );
}

/**
 * Jack, queen and king: two mirrored halves either side of a rule.
 *
 * Real court cards are engraved figures, and a faked one looks far worse than no figure
 * at all. What actually makes a court card read as a court card is the *composition* -
 * a framed panel, mirrored top to bottom, so it survives being turned around like every
 * other card in the deck. That is what this draws, in the display serif.
 */
function CourtFace({ label, suit }: { label: string; suit: SuitName }) {
  return (
    <span className="card__court">
      <span className="card__court-half">
        <span className="card__court-letter">{label}</span>
        <SuitGlyph suit={suit} className="card__court-suit" />
      </span>
      <span className="card__court-rule" />
      <span className="card__court-half card__court-half--inverted">
        <span className="card__court-letter">{label}</span>
        <SuitGlyph suit={suit} className="card__court-suit" />
      </span>
    </span>
  );
}
