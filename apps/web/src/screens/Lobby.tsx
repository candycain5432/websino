import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './Lobby.css';

export interface GameCard {
  id: string;
  name: string;
  tagline: string;
  house: string;
  accent: string;
  available: boolean;
}

export const GAMES: GameCard[] = [
  { id: 'dice',       name: 'Dice',        tagline: 'Roll over or under your number', house: 'Edge 1%',    accent: 'var(--info)',   available: true },
  { id: 'limbo',      name: 'Limbo',       tagline: 'Pick a target, clear it, cash',  house: 'Edge 1%',    accent: 'var(--purple)', available: true },
  { id: 'blackjack',  name: 'Blackjack',   tagline: 'Six decks, dealer stands soft 17', house: 'Edge 0.5%', accent: 'var(--win)',    available: true },
  { id: 'slots',      name: 'Golden Reels',tagline: '20 lines, wilds, free spins',    house: 'RTP 94.7%',  accent: 'var(--gold)',   available: true },
  { id: 'crash',      name: 'Crash',       tagline: 'Cash out before the curve dies', house: 'Edge 1%',    accent: 'var(--warn)',   available: true },
  { id: 'roulette',   name: 'Roulette',    tagline: 'Single zero, the whole felt',      house: 'Edge 2.7%',  accent: 'var(--lose)',   available: true },
  { id: 'mines',      name: 'Mines',       tagline: 'Find gems, cash out before a bomb', house: 'Edge 1%',    accent: 'var(--info)',   available: true },
  { id: 'videopoker', name: 'Jacks or Better', tagline: 'Full-pay 9/6 video poker',     house: 'RTP 99.5%',  accent: 'var(--push)',   available: true },
  { id: 'holdem',     name: "Texas Hold'em", tagline: 'No-limit tables with real players', house: 'Multiplayer', accent: 'var(--purple)', available: false },
];

export function Lobby({
  transport,
  balance,
  onOpen,
  onTopUp,
  onSignOut,
}: {
  transport: GameTransport;
  balance: number;
  onOpen: (id: string) => void;
  onTopUp: () => void;
  onSignOut?: (() => void) | undefined;
}) {
  return (
    <div className="lobby">
      <header className="lobby__header">
        <div className="lobby__brand">
          <div className="lobby__cards" aria-hidden="true">
            <PlayingCard card={51} size="sm" />
            <PlayingCard card={48} size="sm" />
          </div>
          <div>
            <h1 className="lobby__title">Websino</h1>
            <p className="lobby__tagline">One chip stack. Every table. Provably fair.</p>
          </div>
        </div>

        <div className="lobby__wallet">
          {transport.mode === 'practice' && <span className="lobby__mode">Practice</span>}
          <span className="lobby__balance numeric">{formatChips(balance)}</span>
          {transport.topUp && (
            <button className="btn btn--ghost lobby__topup" onClick={onTopUp}>
              Top up
            </button>
          )}
          {onSignOut && (
            <button className="btn btn--ghost lobby__topup" onClick={onSignOut}>
              {transport.mode === 'practice' ? 'Sign in' : 'Sign out'}
            </button>
          )}
        </div>
      </header>

      {transport.mode === 'practice' && (
        <p className="lobby__notice">
          You are playing in <strong>practice mode</strong>. These chips are local to this
          browser and never reach an account — sign in to play with your real balance.
        </p>
      )}

      <ul className="lobby__grid">
        {GAMES.map((game) => (
          <li key={game.id}>
            <button
              className={`tile${game.available ? '' : ' tile--soon'}`}
              style={{ '--tile-accent': game.accent } as React.CSSProperties}
              onClick={() => game.available && onOpen(game.id)}
              disabled={!game.available}
            >
              <span className="tile__glow" aria-hidden="true" />
              <span className="tile__name">{game.name}</span>
              <span className="tile__tagline">{game.tagline}</span>
              <span className="tile__badge">{game.available ? game.house : 'Coming soon'}</span>
            </button>
          </li>
        ))}
      </ul>

      <footer className="lobby__footer">
        Play money only. No purchases, no cash-outs, no real currency anywhere.
      </footer>
    </div>
  );
}
