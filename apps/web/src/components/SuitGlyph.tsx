/**
 * The four suits, drawn.
 *
 * Not `♠♥♦♣`. Those are font glyphs, so their weight, proportion and even their shape
 * change with whatever happens to be installed - the club is a different drawing on
 * macOS, Windows and Android, and on several Android builds the spade renders as an
 * emoji, in colour, at the wrong size. A card is the one place in this interface where
 * the mark *is* the content, so it is drawn here and looks the same everywhere.
 *
 * One 100x100 viewBox for all four, so a pip placed at a given size is the same optical
 * weight whichever suit it is - which is the thing you notice immediately if it is
 * wrong, in a hand of mixed suits.
 */

export type SuitName = 'spade' | 'heart' | 'diamond' | 'club';

/** Engine suit indices: 0 spade, 1 heart, 2 diamond, 3 club. */
export const SUIT_NAMES: readonly SuitName[] = ['spade', 'heart', 'diamond', 'club'];

export function SuitGlyph({ suit, className }: { suit: SuitName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      // Decorative: every card that uses these already carries its own accessible name.
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      {suit === 'spade' && (
        <>
          <path d="M50 4C50 4 95 39 95 63c0 14-10 24-23 24-9 0-17-5-22-13-5 8-13 13-22 13C15 87 5 77 5 63 5 39 50 4 50 4Z" />
          <path d="M50 58c0 18-4 31-13 39h26c-9-8-13-21-13-39Z" />
        </>
      )}

      {suit === 'heart' && (
        <path d="M50 94S5 62 5 36C5 18 18 6 33 6c9 0 15 5 17 10 2-5 8-10 17-10 15 0 28 12 28 30 0 26-45 58-45 58Z" />
      )}

      {suit === 'diamond' && <path d="M50 3 90 50 50 97 10 50Z" />}

      {suit === 'club' && (
        <>
          <circle cx="50" cy="27" r="22" />
          <circle cx="25" cy="62" r="22" />
          <circle cx="75" cy="62" r="22" />
          <path d="M50 55c0 19-4 33-13 42h26c-9-9-13-23-13-42Z" />
        </>
      )}
    </svg>
  );
}
