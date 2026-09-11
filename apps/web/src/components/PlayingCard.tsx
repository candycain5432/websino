import { cardName, isRed, rankLabel, suitSymbol, type Card } from '@websino/engine';

import './PlayingCard.css';

/**
 * A playing card as real DOM.
 *
 * pysino drew these pixel by pixel onto a canvas, so they were blurry when scaled and
 * invisible to a screen reader. These are elements: crisp at any size, flippable with
 * a CSS rotateY (the Python version faked exactly that with a horizontal squash), and
 * they carry their own accessible name.
 */
export function PlayingCard({
  card,
  faceUp = true,
  size = 'md',
  highlighted = false,
}: {
  card?: Card;
  faceUp?: boolean;
  size?: 'sm' | 'md' | 'lg';
  highlighted?: boolean;
}) {
  const showFace = faceUp && card !== undefined;
  const classes = [
    'card',
    `card--${size}`,
    showFace ? '' : 'card--down',
    highlighted ? 'card--highlighted' : '',
    showFace && isRed(card) ? 'card--red' : 'card--black',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} role="img" aria-label={showFace ? cardName(card) : 'face down card'}>
      <div className="card__inner">
        {showFace ? (
          <>
            <span className="card__corner card__corner--tl">
              <span className="card__rank">{rankLabel(card)}</span>
              <span className="card__suit">{suitSymbol(card)}</span>
            </span>
            <span className="card__pip">{suitSymbol(card)}</span>
            <span className="card__corner card__corner--br">
              <span className="card__rank">{rankLabel(card)}</span>
              <span className="card__suit">{suitSymbol(card)}</span>
            </span>
          </>
        ) : (
          <span className="card__back" />
        )}
      </div>
    </div>
  );
}
