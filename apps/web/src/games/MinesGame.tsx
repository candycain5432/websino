import { mines as minesRules, type MinesView } from '@websino/engine';
import { useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './MinesGame.css';

const { GRID_SIZE, TILE_COUNT, MAX_MINES, MIN_MINES } = minesRules;

export function MinesGame({
  transport,
  balance,
  onBalance,
  onBack,
}: {
  transport: GameTransport;
  balance: number;
  onBalance: (balance: number) => void;
  onBack: () => void;
}) {
  const [bet, setBet] = useState(25);
  const [mineCount, setMineCount] = useState(3);
  const [view, setView] = useState<MinesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A board in progress has already cost the stake, so pick it back up on reload.
  useEffect(() => {
    void transport.mines.status()
      .then((existing) => { if (existing) setView(existing); })
      .catch(() => { /* nothing in progress */ });
  }, [transport]);

  const playing = view?.state === 'playing';

  const record = (finished: MinesView): void => {
    setHistory((prev) => [
      {
        id: Date.now() + Math.random(),
        label: finished.state === 'busted'
          ? `Bombed on pick ${finished.picks + 1}`
          : `${finished.picks} safe · ${formatMultiplier(finished.multiplier)}`,
        won: finished.payout > finished.bet,
        net: finished.payout - finished.bet,
      },
      ...prev,
    ]);
  };

  const run = async (work: () => Promise<MinesView>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      setView(next);
      onBalance(next.balance);
      if (next.state !== 'playing') record(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const start = (): void => void run(() => transport.mines.start(bet, mineCount));
  const reveal = (position: number): void => void run(() => transport.mines.reveal(position));
  const cashOut = (): void => void run(() => transport.mines.cashOut());

  const revealed = new Set(view?.revealed ?? []);
  const minePositions = new Set(view?.minePositions ?? []);
  const finished = view !== null && view.state !== 'playing';

  // The ladder the player is climbing, so the next rung is always visible.
  const ladder = minesRules.multiplierTable(view?.mines ?? mineCount).slice(0, 8);

  return (
    <GameShell
      title="Mines"
      subtitle="Every cash-out point is worth exactly the same — only the variance changes"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy || playing}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="mines">
          <div
            className={`mines__grid${finished ? ' is-over' : ''}`}
            role="grid"
            aria-label={`${GRID_SIZE} by ${GRID_SIZE} minefield`}
          >
            {Array.from({ length: TILE_COUNT }, (_, position) => {
              const isSafe = revealed.has(position);
              const isMine = minePositions.has(position);
              const isHit = view?.hitPosition === position;
              return (
                <button
                  key={position}
                  className={[
                    'mines__tile',
                    isSafe ? 'is-safe' : '',
                    finished && isMine ? 'is-mine' : '',
                    isHit ? 'is-hit' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => reveal(position)}
                  disabled={busy || !playing || isSafe}
                  aria-label={
                    isSafe ? 'gem' : finished && isMine ? 'mine' : `tile ${position + 1}`
                  }
                >
                  <span aria-hidden="true">
                    {isSafe ? '◆' : finished && isMine ? '✸' : ''}
                  </span>
                </button>
              );
            })}
          </div>

          <output className={`mines__readout${finished ? (view.payout > view.bet ? ' is-win' : ' is-loss') : ''}`}>
            {view === null
              ? 'Pick your mines and start a board'
              : view.state === 'busted'
                ? 'Bombed'
                : view.state === 'cashed'
                  ? `Cashed out for ${formatChips(view.payout)}`
                  : `${formatMultiplier(view.multiplier)} · ${formatChips(view.payout)}`}
          </output>
        </div>
      }
      controls={
        <div className="mines__controls">
          {!playing && (
            <>
              <label className="mines__slider-label">
                <span>Mines</span>
                <strong className="numeric">{mineCount}</strong>
              </label>
              <input
                className="mines__slider"
                type="range"
                min={MIN_MINES}
                max={MAX_MINES}
                value={mineCount}
                disabled={busy}
                onChange={(event) => setMineCount(Number(event.target.value))}
              />
              <p className="mines__hint">
                More mines climb faster and die sooner. The expected return is identical
                either way — {MIN_MINES} mine or {MAX_MINES}, one pick or the whole board.
              </p>
            </>
          )}

          {playing && view && (
            <dl className="mines__stats">
              <div>
                <dt>Picks</dt>
                <dd className="numeric">{view.picks}</dd>
              </div>
              <div>
                <dt>Next</dt>
                <dd className="numeric">
                  {view.nextMultiplier === null ? '—' : formatMultiplier(view.nextMultiplier)}
                </dd>
              </div>
            </dl>
          )}

          {error && <p className="mines__error">{error}</p>}

          {playing ? (
            <button
              className="btn btn--primary mines__action"
              onClick={cashOut}
              disabled={busy || (view?.picks ?? 0) === 0}
            >
              {(view?.picks ?? 0) === 0
                ? 'Reveal a tile first'
                : `Cash out ${formatChips(view?.payout ?? 0)}`}
            </button>
          ) : (
            <button
              className="btn btn--primary mines__action"
              onClick={start}
              disabled={busy || bet > balance}
            >
              {busy ? 'Dealing…' : 'New board'}
            </button>
          )}

          <div className="mines__ladder">
            <h2 className="mines__ladder-title">Ladder · {view?.mines ?? mineCount} mines</h2>
            <ol>
              {ladder.map((multiplier, index) => (
                <li
                  key={index}
                  className={view && view.picks === index + 1 ? 'is-here' : ''}
                >
                  <span className="numeric">{index + 1}</span>
                  <span className="numeric">{formatMultiplier(multiplier)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      }
    />
  );
}
