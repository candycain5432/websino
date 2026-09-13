/**
 * The bingo hall: cards, a caller, and a board of numbers everybody in the room shares.
 *
 * Like the shared tables, this does not use `GameShell` - the shell is built around one
 * player's bet-and-result loop, and here the round belongs to the room. Unlike the tables,
 * there is nothing to take turns over: the only decision is how many cards and at what
 * stake, and after that the screen's job is to make forty seconds of numbers legible.
 *
 * Two pieces of local state, both drafts rather than beliefs: the card count and the
 * stake, which are what the buy intent is made of. Everything else on screen is the
 * server's snapshot. In particular the *marks* on a card are the server's - working out
 * which squares are covered from the ball list would be a second implementation of the
 * rules, and the whole point of the engine owning line geometry is that there is one.
 *
 * The caller animates between pushes off `ballMs`, but only ever within balls it has
 * already been sent. It never runs ahead of the snapshot, so a fast connection cannot see
 * a ball early and a slow one only ever lags.
 */

import type { BingoCardView, BingoView } from '@websino/engine';
import { useEffect, useMemo, useRef, useState } from 'react';

import { formatChips } from '../lib/format.js';
import { BingoSocket, type BingoStatus } from '../lib/bingoSocket.js';
import './BingoHall.css';

const HALL_ID = 'bingo-hall';

const LETTERS = ['B', 'I', 'N', 'G', 'O'] as const;

const STATUS_LABELS: Record<BingoStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting — your cards are safe',
  closed: 'Disconnected',
};

const PHASE_LABELS: Record<BingoView['phase'], string> = {
  buying: 'Buy your cards',
  drawing: 'Eyes down',
  results: 'Results',
};

export function BingoHall({
  balance,
  onBalance,
  onBack,
}: {
  balance: number;
  onBalance: (balance: number) => void;
  onBack: () => void;
}) {
  const [hall, setHall] = useState<BingoView | null>(null);
  const [status, setStatus] = useState<BingoStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState(2);
  const [stake, setStake] = useState(25);
  const socketRef = useRef<BingoSocket | null>(null);

  useEffect(() => {
    const socket = new BingoSocket({
      onState: setHall,
      onStatus: setStatus,
      onError: setError,
    });
    socketRef.current = socket;
    socket.watch(HALL_ID);
    return () => { socket.close(); socketRef.current = null; };
  }, []);

  // The header's balance is the server's, never ours to compute.
  useEffect(() => {
    if (hall) onBalance(hall.balance);
  }, [hall?.balance]);

  // A fresh round clears last round's error, so a refused buy does not linger for a
  // window in which it is no longer true.
  useEffect(() => setError(null), [hall?.round]);

  if (!hall) {
    return (
      <div className="hall hall--loading">
        <p>{STATUS_LABELS[status]}</p>
      </div>
    );
  }

  const total = cards * stake;
  const affordable = total <= balance;

  return (
    <div className="hall">
      <header className="hall__bar">
        <button className="hall__back" onClick={onBack} aria-label="Back to the lobby">
          ← Lobby
        </button>
        <div className="hall__titles">
          <h1>{hall.name}</h1>
          <p>
            {PHASE_LABELS[hall.phase]} · round {hall.round} ·{' '}
            {hall.players === 0
              ? 'nobody in yet'
              : `${hall.players} ${hall.players === 1 ? 'player' : 'players'}`}
          </p>
        </div>
        <span className={`hall__status hall__status--${status}`}>{STATUS_LABELS[status]}</span>
      </header>

      <Caller hall={hall} />

      {hall.cards.length > 0 ? (
        <ol className="hall__cards">
          {hall.cards.map((card, index) => (
            <li key={index}>
              <Card card={card} index={index} phase={hall.phase} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="hall__sitting-out">
          {hall.phase === 'buying'
            ? 'Buy a card to play this round.'
            : 'You are watching this round — buy in when the next one opens.'}
        </div>
      )}

      <div className="hall__controls">
        {hall.canBuy ? (
          <div className="buyin">
            <div className="buyin__counts" role="group" aria-label="How many cards">
              {Array.from({ length: hall.maxCards }, (_, i) => i + 1).map((count) => (
                <button
                  key={count}
                  className={`buyin__count ${count === cards ? 'is-on' : ''}`}
                  onClick={() => setCards(count)}
                  aria-pressed={count === cards}
                >
                  {count} {count === 1 ? 'card' : 'cards'}
                </button>
              ))}
            </div>

            <label className="buyin__stake">
              <span>
                Stake per card <strong className="numeric">{formatChips(stake)}</strong>
              </span>
              <input
                type="range"
                min={hall.minStake}
                max={Math.min(hall.maxStake, Math.max(hall.minStake, Math.floor(balance / cards)))}
                value={stake}
                onChange={(event) => setStake(Number(event.target.value))}
              />
            </label>

            <button
              className="btn btn--primary buyin__go"
              disabled={!affordable || status !== 'open'}
              onClick={() => {
                setError(null);
                socketRef.current?.buy(HALL_ID, cards, stake);
              }}
            >
              {affordable
                ? `Buy ${cards} for ${formatChips(total)}`
                : `You need ${formatChips(total)}`}
            </button>
          </div>
        ) : (
          <p className="hall__waiting">
            {hall.phase === 'buying' && hall.cards.length > 0
              ? `You are in for ${formatChips(hall.yourStake)} — waiting for the caller…`
              : hall.phase === 'drawing'
                ? `${hall.called.length} of ${hall.ballsDrawn} called`
                : hall.yourPayout > 0
                  ? `Round ${hall.round} paid you ${formatChips(hall.yourPayout)}`
                  : 'Next round in a moment…'}
          </p>
        )}

        {error && <p className="hall__error">{error}</p>}
      </div>

      <Paytable hall={hall} />

      {hall.log.length > 0 && (
        <div className="hall__log">
          <h2>In the hall</h2>
          <ol>{hall.log.slice(-8).map((line, i) => <li key={i}>{line}</li>)}</ol>
        </div>
      )}

      <p className="hall__note">
        Everybody in the round watches the same balls, and every card is paid on its own
        against the table above — nobody else joining ever costs you anything. Your cards
        come off your own fair stream; the ball sequence comes off the first buyer&rsquo;s.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- the caller --

/**
 * The board of called numbers, and the ball on the lip.
 *
 * The countdown is to the server's `deadline`, not from a local duration, so a client that
 * loaded late or has a skewed clock still lands on the same instant as everyone else. The
 * draw can finish *before* that deadline - it stops once every card is settled - which is
 * why the bar is drawn from the balls actually called rather than from the time left.
 */
function Caller({ hall }: { hall: BingoView }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const latest = hall.called[hall.called.length - 1];
  const remaining = Math.max(0, hall.deadline - now);
  const called = new Set(hall.called);
  const progress = hall.phase === 'buying' ? 0 : hall.called.length / hall.ballsDrawn;

  return (
    <section className="caller" aria-live="polite">
      <div className="caller__stage">
        {latest === undefined ? (
          <div className="caller__idle">
            {hall.phase === 'buying' ? (
              <>
                <span className="caller__idle-label">Next round in</span>
                <strong className="caller__idle-value numeric">
                  {Math.ceil(remaining / 1_000)}s
                </strong>
              </>
            ) : (
              <span className="caller__idle-label">Warming up the drum…</span>
            )}
          </div>
        ) : (
          <div className="caller__ball" key={latest}>
            <span className="caller__letter">{letterFor(latest)}</span>
            <strong className="caller__number numeric">{latest}</strong>
          </div>
        )}

        <div className="caller__meta">
          <span className="numeric">
            {hall.called.length} / {hall.ballsDrawn}
          </span>
          {hall.staked > 0 && (
            <span className="numeric">{formatChips(hall.staked)} staked</span>
          )}
          {hall.lastRound && hall.lastRound.bestMultiplier > 0 && (
            <span>
              Last round&rsquo;s best {hall.lastRound.bestMultiplier}×
              {hall.lastRound.bestBall !== null && ` on ball ${hall.lastRound.bestBall}`}
            </span>
          )}
        </div>
      </div>

      <div className="caller__progress">
        <div className="caller__progress-bar" style={{ transform: `scaleX(${progress})` }} />
      </div>

      {/* Every number in the pool, so a player can scan for their own. */}
      <div className="caller__board">
        {LETTERS.map((letter, column) => (
          <div className="caller__column" key={letter}>
            <span className="caller__column-letter">{letter}</span>
            {Array.from({ length: 15 }, (_, i) => column * 15 + i + 1).map((number) => (
              <span
                key={number}
                className={`caller__cell numeric ${called.has(number) ? 'is-called' : ''} ${
                  number === latest ? 'is-latest' : ''
                }`}
              >
                {number}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

const letterFor = (ball: number): string => LETTERS[Math.floor((ball - 1) / 15)] ?? '';

// --------------------------------------------------------------------- a card --

function Card({
  card,
  index,
  phase,
}: {
  card: BingoCardView;
  index: number;
  phase: BingoView['phase'];
}) {
  // `marked` and `line` are the server's answers, keyed for O(1) lookup while rendering.
  const marked = useMemo(
    () => new Set(card.marked.map(([row, column]) => `${row}:${column}`)),
    [card.marked],
  );
  const winning = useMemo(
    () => new Set(card.line.map(([row, column]) => `${row}:${column}`)),
    [card.line],
  );

  const won = card.completedOn !== null;

  return (
    <div
      className={[
        'bcard',
        won ? 'is-won' : '',
        !won && card.toGo === 1 && phase === 'drawing' ? 'is-close' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="bcard__head">
        <span className="bcard__label">Card {index + 1}</span>
        {won ? (
          <span className="bcard__won numeric">
            {card.multiplier}× · {formatChips(card.payout)}
          </span>
        ) : phase === 'drawing' ? (
          <span className="bcard__togo">
            {card.toGo === 1 ? 'one away' : `${card.toGo} to go`}
          </span>
        ) : null}
      </div>

      <div className="bcard__letters" aria-hidden="true">
        {LETTERS.map((letter) => <span key={letter}>{letter}</span>)}
      </div>

      <div className="bcard__grid">
        {card.numbers.map((row, r) =>
          row.map((value, c) => {
            const key = `${r}:${c}`;
            return (
              <span
                key={key}
                className={[
                  'bcard__cell',
                  'numeric',
                  value === null ? 'is-free' : '',
                  marked.has(key) ? 'is-marked' : '',
                  winning.has(key) ? 'is-line' : '',
                ].filter(Boolean).join(' ')}
              >
                {value === null ? '★' : value}
              </span>
            );
          }),
        )}
      </div>

      {won && (
        <p className="bcard__why">
          Line on ball {card.completedOn}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ paytable --

/** What a line is worth, by how fast it lands. The odds are the engine's exact ones. */
function Paytable({ hall }: { hall: BingoView }) {
  const reached = hall.called.length;

  return (
    <table className="btiers">
      <caption>
        Paid on the ball your line lands on · {hall.ballsDrawn} balls a round
      </caption>
      <thead>
        <tr>
          <th scope="col">Line by ball</th>
          <th scope="col">Pays</th>
          <th scope="col">Chance</th>
        </tr>
      </thead>
      <tbody>
        {hall.tiers.map((tier, index) => {
          const from = index === 0 ? 1 : (hall.tiers[index - 1]?.upTo ?? 0) + 1;
          return (
            <tr
              key={tier.upTo}
              // Which band the caller is in right now, so the table reads as live.
              className={reached >= from && reached <= tier.upTo ? 'is-here' : ''}
            >
              <td className="numeric">{from}–{tier.upTo}</td>
              <td className="numeric">{tier.multiplier}×</td>
              <td className="numeric">{(tier.chance * 100).toFixed(1)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
