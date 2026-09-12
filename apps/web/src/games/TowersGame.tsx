import type { TowersView } from '@websino/engine';
import { useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport, TowersDifficulty } from '../lib/transport.js';
import './TowersGame.css';

const LEVELS: TowersDifficulty[] = ['easy', 'medium', 'hard', 'expert', 'master'];

/** Tiles and traps per row, purely so the picker can describe a level before you pick it. */
const SHAPE: Record<TowersDifficulty, string> = {
  easy: '1 trap in 4',
  medium: '1 trap in 3',
  hard: '1 trap in 2',
  expert: '2 traps in 3',
  master: '3 traps in 4',
};

export function TowersGame({
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
  const [bet, setBet] = useState(10);
  const [difficulty, setDifficulty] = useState<TowersDifficulty>('medium');
  const [view, setView] = useState<TowersView | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The stake is already spent, so a tower in progress has to come back on reload.
  useEffect(() => {
    void transport.towers.status()
      .then((existing) => { if (existing) { setView(existing); setDifficulty(existing.difficulty); } })
      .catch(() => { /* nothing open */ });
  }, [transport]);

  const run = async (work: () => Promise<TowersView>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      setView(next);
      onBalance(next.balance);

      if (next.state !== 'playing') {
        const net = next.payout - next.bet;
        setHistory((prev) => [
          {
            id: Date.now() + Math.random(),
            label: next.state === 'busted'
              ? `fell on row ${(next.hit?.row ?? 0) + 1}`
              : `${next.picks.length} rows · ${formatMultiplier(next.multiplier)}`,
            won: net > 0,
            net,
          },
          ...prev,
        ]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const live = view?.state === 'playing';
  const finished = view !== null && view.state !== 'playing';

  const start = (): void => void run(() => transport.towers.start(bet, difficulty));
  const step = (tile: number): void => void run(() => transport.towers.climb(tile));
  const cashOut = (): void => void run(() => transport.towers.cashOut());

  // Preview the ladder for the chosen level, so the climb is legible before it starts.
  const preview = view ?? null;
  const rows = preview?.rows ?? 8;
  const tiles = preview?.tiles ?? 3;
  const reached = preview?.picks.length ?? 0;

  /** Rows render top-first, which is how a tower is read. */
  const ladder = Array.from({ length: rows }, (_, i) => rows - 1 - i);

  return (
    <GameShell
      title="Towers"
      subtitle="Climb one row at a time · every height returns 99%"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy || live}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="towers">
          {view === null ? (
            <div className="towers__empty">
              <h2>Pick a tile, climb a row</h2>
              <p>
                One tile in each row ends the run. Stopping is always an option and never
                a worse one: every height carries exactly the same expected return, so
                the only thing the choice changes is the variance.
              </p>
            </div>
          ) : (
            <ol className="towers__ladder">
              {ladder.map((row) => {
                const cleared = row < reached;
                const active = live && row === reached;
                const pick = preview?.picks[row];
                return (
                  <li
                    key={row}
                    className={[
                      'rung',
                      cleared ? 'is-cleared' : '',
                      active ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <span className="rung__pay numeric">
                      {formatMultiplier(preview?.table[row] ?? 0)}
                    </span>

                    <div className="rung__tiles">
                      {Array.from({ length: tiles }, (_, tile) => {
                        // The trap map only exists once the round is over, so a live
                        // tile genuinely has nothing on it to read.
                        const trap = finished && preview?.trapMap?.[row]?.includes(tile);
                        const chosen = cleared && pick === tile;
                        const fell = finished
                          && preview?.hit?.row === row && preview.hit.tile === tile;
                        return (
                          <button
                            key={tile}
                            className={[
                              'rung__tile',
                              chosen ? 'is-chosen' : '',
                              trap ? 'is-trap' : '',
                              fell ? 'is-fell' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => step(tile)}
                            disabled={!active || busy}
                            aria-label={`row ${row + 1} tile ${tile + 1}`}
                          >
                            {fell ? '✕' : trap ? '✕' : chosen ? '●' : ''}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      }
      controls={
        <div className="towers__controls">
          {!live && (
            <fieldset className="towers__set">
              <legend>Difficulty</legend>
              <div className="towers__choices">
                {LEVELS.map((level) => (
                  <button
                    key={level}
                    className={`chip-btn${difficulty === level ? ' is-active' : ''}`}
                    onClick={() => setDifficulty(level)}
                    disabled={busy}
                    title={SHAPE[level]}
                  >
                    {level}
                  </button>
                ))}
              </div>
              <p className="towers__shape">{SHAPE[difficulty]} on every row</p>
            </fieldset>
          )}

          {!live ? (
            <button
              className="btn btn--primary towers__wide"
              onClick={start}
              disabled={busy || bet > balance || bet < 1}
            >
              {busy ? 'Building…' : `Climb for ${formatChips(bet)}`}
            </button>
          ) : (
            <>
              <button
                className="btn btn--ghost towers__wide"
                onClick={cashOut}
                disabled={busy || reached === 0}
              >
                {reached === 0 ? 'Clear a row first' : `Take ${formatChips(view.payout)}`}
              </button>

              <dl className="towers__meters">
                <div>
                  <dt>Height</dt>
                  <dd className="numeric">{reached} / {rows}</dd>
                </div>
                <div>
                  <dt>Next rung</dt>
                  <dd className="numeric">
                    {view.nextMultiplier === null ? '—' : formatMultiplier(view.nextMultiplier)}
                  </dd>
                </div>
              </dl>
            </>
          )}

          {error && <p className="towers__error">{error}</p>}

          <p className="towers__note">
            Each rung pays the inverse of the chance of reaching it, times 99%. That is
            what makes every stopping point worth the same — climbing higher buys
            variance, not value.
          </p>
        </div>
      }
    />
  );
}
