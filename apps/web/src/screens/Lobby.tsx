/**
 * The floor.
 *
 * The first version was fifteen identical rectangles carrying a name, a tagline and a
 * badge, in one flat grid. That is a *list* of games, and a list is something you read;
 * nobody reads fifteen items to decide what to play. Three things fix it, and all three
 * are lifted from how a real floor - and pysino's lobby - actually works:
 *
 *   **Every tile shows its game.** A hand of cards, a reel window reading 7-7-7, a
 *   wheel, a rising curve. You find what you want by recognising it, not by reading it.
 *   See `GamePreview`.
 *
 *   **The floor is zoned.** A casino does not shuffle its roulette wheels in among its
 *   slot machines; it has a card room and a machine floor. Fifteen games in one
 *   undifferentiated grid is the same mistake, and splitting them into three named rooms
 *   costs nothing and makes the page scannable.
 *
 *   **The house tells you how you are doing.** Rounds played, lifetime wagered, net and
 *   peak stack across the foot. The lobby is where you arrive and where you come back
 *   between games, so it is the one screen that should answer "how has this been going".
 */

import { useEffect, useState } from 'react';

import { GamePreview } from '../components/GamePreview.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { SuitGlyph, type SuitName } from '../components/SuitGlyph.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport, PlayerStats } from '../lib/transport.js';
import './Lobby.css';

export interface GameCard {
  id: string;
  name: string;
  tagline: string;
  house: string;
  accent: string;
  available: boolean;
  /** Which room on the floor it belongs to. */
  room: 'cards' | 'floor' | 'fast';
  /** Needs a server and other people, so practice mode cannot offer it. */
  onlineOnly?: boolean;
}

export const GAMES: GameCard[] = [
  // The card room: everything dealt from a deck.
  { id: 'blackjack',  name: 'Blackjack',   tagline: 'Six decks, dealer stands soft 17', house: 'Edge 0.5%', accent: 'var(--win)',    available: true, room: 'cards' },
  { id: 'holdem',     name: "Texas Hold'em", tagline: 'No-limit against Monte Carlo bots', house: 'You vs bots', accent: 'var(--purple)', available: true, room: 'cards' },
  { id: 'tables',     name: 'Shared tables', tagline: 'Live hold’em with other people', house: 'Multiplayer', accent: 'var(--gold-bright)', available: true, room: 'cards', onlineOnly: true },
  { id: 'videopoker', name: 'Jacks or Better', tagline: 'Full-pay 9/6 video poker',     house: 'RTP 99.5%',  accent: 'var(--push)',   available: true, room: 'cards' },

  // The main floor: the machines and the big shared draws.
  { id: 'roulette',   name: 'Roulette',    tagline: 'Single zero, the whole felt',      house: 'Edge 2.7%',  accent: 'var(--lose)',   available: true, room: 'floor' },
  { id: 'slots',      name: 'Slots',       tagline: 'Three cabinets, wilds, free spins', house: 'RTP 94.7%',  accent: 'var(--gold)',   available: true, room: 'floor' },
  { id: 'wheel',      name: 'Wheel of Fortune', tagline: 'One spin, one segment',      house: 'RTP 99%',    accent: 'var(--gold)',   available: true, room: 'floor' },
  { id: 'bingo',      name: 'Bingo',       tagline: 'One ball sequence, everybody watching', house: 'RTP 99%',    accent: 'var(--silver)', available: true, room: 'floor', onlineOnly: true },

  // Fast games: one decision, settled in seconds.
  { id: 'crash',      name: 'Crash',       tagline: 'Cash out before the curve dies', house: 'Edge 1%',    accent: 'var(--warn)',   available: true, room: 'fast' },
  { id: 'mines',      name: 'Mines',       tagline: 'Find gems, cash out before a bomb', house: 'Edge 1%',    accent: 'var(--info)',   available: true, room: 'fast' },
  { id: 'plinko',     name: 'Plinko',      tagline: 'Drop a ball, take the bucket',   house: 'RTP 99%',    accent: 'var(--warn)',   available: true, room: 'fast' },
  { id: 'towers',     name: 'Towers',      tagline: 'Climb rows, dodge the traps',    house: 'Edge 1%',    accent: 'var(--win)',    available: true, room: 'fast' },
  { id: 'dice',       name: 'Dice',        tagline: 'Roll over or under your number', house: 'Edge 1%',    accent: 'var(--info)',   available: true, room: 'fast' },
  { id: 'limbo',      name: 'Limbo',       tagline: 'Pick a target, clear it, cash',  house: 'Edge 1%',    accent: 'var(--purple)', available: true, room: 'fast' },
  { id: 'hilo',       name: 'Hi-Lo',       tagline: 'Higher or lower, over and over', house: 'Edge 1%',    accent: 'var(--info)',   available: true, room: 'fast' },
];

const ROOMS: ReadonlyArray<{ id: GameCard['room']; name: string; blurb: string }> = [
  { id: 'cards', name: 'The card room', blurb: 'Dealt from a real deck' },
  { id: 'floor', name: 'The floor', blurb: 'Wheels, reels and a shared draw' },
  { id: 'fast',  name: 'Fast games', blurb: 'One decision, settled in seconds' },
];

const MOTIF: ReadonlyArray<SuitName> = ['spade', 'heart', 'diamond', 'club'];

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
  const [stats, setStats] = useState<PlayerStats | null>(null);

  /*
   * Re-read whenever the balance moves, which is the signal that a round happened.
   * The lobby is only ever reached between games, so this is at most one request per
   * visit rather than a poll.
   */
  useEffect(() => {
    let live = true;
    void transport.getStats()
      .then((next) => { if (live) setStats(next); })
      .catch(() => { if (live) setStats(null); });
    return () => { live = false; };
  }, [transport, balance]);

  const practice = transport.mode === 'practice';

  return (
    <div className="lobby">
      {/* The house mark, very faint, behind everything. */}
      <div className="lobby__motif" aria-hidden="true">
        {MOTIF.map((suit) => (
          <SuitGlyph key={suit} suit={suit} className="lobby__motif-suit" />
        ))}
      </div>

      <header className="lobby__bar">
        <span className="lobby__here">Lobby</span>
        <span className="lobby__wallet">
          {practice && <span className="lobby__mode">Practice</span>}
          <span className="lobby__balance numeric">{formatChips(balance)}</span>
          {transport.topUp && (
            <button className="btn btn--ghost lobby__action" onClick={onTopUp}>
              Top up
            </button>
          )}
          {onSignOut && (
            <button className="btn btn--ghost lobby__action" onClick={onSignOut}>
              {practice ? 'Sign in' : 'Sign out'}
            </button>
          )}
        </span>
      </header>

      <div className="lobby__hero">
        <div className="lobby__cards" aria-hidden="true">
          <PlayingCard card={51} size="sm" />
          <PlayingCard card={48} size="sm" />
        </div>
        <h1 className="lobby__title">Websino</h1>
        <p className="lobby__tagline">One chip stack. Every table. Provably fair.</p>
      </div>

      {practice && (
        <p className="lobby__notice">
          You are playing in <strong>practice mode</strong>. These chips are local to this
          browser and never reach an account — sign in to play with your real balance.
        </p>
      )}

      {ROOMS.map((room) => (
        <section className="lobby__room" key={room.id}>
          <h2 className="lobby__room-name">
            {room.name}
            <span className="lobby__room-blurb">{room.blurb}</span>
          </h2>

          <ul className="lobby__grid">
            {GAMES.filter((game) => game.room === room.id).map((game) => {
              // A shared game needs a server and other people, so practice offers it
              // greyed out and says why rather than pretending it is missing.
              const offline = game.onlineOnly === true && practice;
              const playable = game.available && !offline;
              return (
                <li key={game.id}>
                  <button
                    className={`tile${playable ? '' : ' tile--soon'}`}
                    style={{ '--tile-accent': game.accent } as React.CSSProperties}
                    onClick={() => playable && onOpen(game.id)}
                    disabled={!playable}
                  >
                    <span className="tile__glow" aria-hidden="true" />
                    <GamePreview game={game.id} />
                    <span className="tile__name">{game.name}</span>
                    <span className="tile__tagline">{game.tagline}</span>
                    <span className="tile__badge">
                      {offline ? 'Sign in to play' : game.available ? game.house : 'Coming soon'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <Ledger stats={stats} practice={practice} />

      <footer className="lobby__footer">
        Play money only. No purchases, no cash-outs, no real currency anywhere.
      </footer>
    </div>
  );
}

/**
 * Four lifetime figures across the foot of the floor.
 *
 * `net` is measured against what the house has *given* - the opening stack, every top-up,
 * every bonus - rather than against a fixed number, so topping up does not read as
 * winning. It is the one figure here that could flatter, so it is the one worth getting
 * right.
 */
function Ledger({ stats, practice }: { stats: PlayerStats | null; practice: boolean }) {
  if (!stats) return null;

  const figures: ReadonlyArray<{ label: string; value: string; tone?: 'win' | 'loss' }> = [
    { label: 'Rounds played', value: formatChips(stats.rounds) },
    { label: 'Lifetime wagered', value: formatChips(stats.wagered) },
    {
      label: 'Net',
      value: `${stats.net > 0 ? '+' : ''}${formatChips(stats.net)}`,
      ...(stats.net === 0 ? {} : { tone: stats.net > 0 ? ('win' as const) : ('loss' as const) }),
    },
    { label: 'Peak stack', value: formatChips(stats.peak) },
  ];

  return (
    <section className="lobby__ledger" aria-label="Your record">
      {figures.map((figure) => (
        <div className="lobby__figure" key={figure.label}>
          <strong className={`lobby__figure-value numeric${figure.tone ? ` is-${figure.tone}` : ''}`}>
            {figure.value}
          </strong>
          <span className="lobby__figure-label">{figure.label}</span>
        </div>
      ))}
      {practice && <p className="lobby__ledger-note">Practice chips, this browser only.</p>}
    </section>
  );
}
