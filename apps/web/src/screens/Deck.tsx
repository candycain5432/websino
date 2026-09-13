/**
 * The whole deck on one page.
 *
 * A design sheet, reachable at `#deck`. It exists because a card component cannot be
 * judged - or checked - five cards at a time: the pip layouts only make sense next to
 * each other, the two is the only rank that shows whether the lattice is centred, the
 * ten is the only one whose index is two glyphs wide, and the courts have to read as a
 * family. Fanning through video poker hands hoping to see a nine is not a review.
 *
 * It is also what the screenshot harness measures. The geometry check used to hand-write
 * card markup inside the browser, so when this component changed the check went on
 * passing against markup that no longer existed anywhere - a test of nothing. Pointing it
 * at a page that renders the real component means the check can only pass if the real
 * cards are right.
 */

import { RANKS, SUITS, makeCard } from '@websino/engine';

import { PlayingCard } from '../components/PlayingCard.js';
import './Deck.css';

const SUIT_ROWS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'] as const;

export function Deck({ onBack }: { onBack: () => void }) {
  return (
    <div className="deck">
      <header className="deck__bar">
        <button className="btn btn--ghost" onClick={onBack}>← Lobby</button>
        <div>
          <h1 className="deck__title">The deck</h1>
          <p className="deck__sub">
            Fifty-two cards, four sizes and the back, as the game draws them.
          </p>
        </div>
      </header>

      {SUIT_ROWS.map((name, suit) => (
        <section className="deck__suit" key={name}>
          <h2 className="deck__suit-name">{name}</h2>
          <div className="deck__row">
            {Array.from({ length: RANKS }, (_, rank) => (
              <PlayingCard key={rank} card={makeCard(rank, suit)} size="md" />
            ))}
          </div>
        </section>
      ))}

      <section className="deck__suit">
        <h2 className="deck__suit-name">Sizes, states and the back</h2>
        <div className="deck__row deck__row--baseline">
          <PlayingCard card={makeCard(12, 0)} size="xs" />
          <PlayingCard card={makeCard(12, 0)} size="sm" />
          <PlayingCard card={makeCard(12, 0)} size="md" />
          <PlayingCard card={makeCard(12, 0)} size="lg" />
          <PlayingCard card={makeCard(8, 1)} size="lg" highlighted />
          <PlayingCard card={makeCard(10, 2)} size="lg" dimmed />
          <PlayingCard faceUp={false} size="lg" />
        </div>
      </section>

      <p className="deck__note">
        Ranks run two to ace across, suits down. Every measurement on a card is a fraction
        of one number — its width — so the row of sizes above is the same drawing four
        times, not four drawings. {RANKS * SUITS} cards.
      </p>
    </div>
  );
}
