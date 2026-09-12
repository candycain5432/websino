import type { HiLoView } from '@websino/engine';
import { useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport, HiLoGuess } from '../lib/transport.js';
import './HiLoGame.css';

export function HiLoGame({
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
  const [view, setView] = useState<HiLoView | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The stake is already spent, so a run in progress has to come back on reload.
  useEffect(() => {
    void transport.hilo.status()
      .then((existing) => { if (existing) setView(existing); })
      .catch(() => { /* no run open */ });
  }, [transport]);

  const run = async (work: () => Promise<HiLoView>): Promise<void> => {
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
              ? `busted on ${next.steps} ${next.steps === 1 ? 'guess' : 'guesses'}`
              : `${next.steps} in a row · ${formatMultiplier(next.multiplier)}`,
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

  const start = (): void => void run(() => transport.hilo.start(bet));
  const make = (choice: HiLoGuess): void => void run(() => transport.hilo.guess(choice));
  const cashOut = (): void => void run(() => transport.hilo.cashOut());

  /**
   * The cards already behind the one on the table, newest first.
   *
   * Built from the opening card plus each turned-over one, with the last dropped -
   * the last is the card on the table, and showing it twice made the board read as if
   * a pair had just come out. The opening card has no step that turned it over, hence
   * the null multiplier.
   */
  const seen = view === null
    ? []
    : [
        { card: view.opening, stepMultiplier: null as number | null, won: true },
        ...view.history.map((step) => ({
          card: step.card,
          stepMultiplier: step.stepMultiplier as number | null,
          won: step.won,
        })),
      ];
  const recent = seen.slice(0, -1).slice(-6).reverse();

  return (
    <GameShell
      title="Hi-Lo"
      subtitle="Higher or lower · every guess priced at 99%"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy || live}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="hilo">
          {view === null ? (
            <div className="hilo__empty">
              <h2>Guess the next card</h2>
              <p>
                Every card is drawn from a full deck, so the odds depend only on the one
                in front of you — and both buttons win on a tie. A guess that cannot lose
                still pays 0.99×, because the edge applies to it too.
              </p>
            </div>
          ) : (
            <>
              <div className="hilo__table">
                <div className={`hilo__current${finished ? ` is-${view.state}` : ''}`}>
                  <PlayingCard card={view.current} size="lg" />
                  <span className="hilo__label">
                    {finished ? (view.state === 'busted' ? 'busted' : 'cashed out') : 'on the table'}
                  </span>
                </div>

                <ol className="hilo__trail">
                  {recent.map((step, i) => (
                    <li key={`${step.card}-${i}`} className={step.won ? 'is-win' : 'is-loss'}>
                      <PlayingCard card={step.card} size="sm" />
                      <span className="numeric">
                        {step.stepMultiplier === null ? 'start' : formatMultiplier(step.stepMultiplier)}
                      </span>
                    </li>
                  ))}
                  {recent.length === 0 && <li className="hilo__trail-empty">no guesses yet</li>}
                </ol>
              </div>

              <dl className="hilo__meters">
                <div>
                  <dt>Streak</dt>
                  <dd className="numeric">{view.steps} / {view.maxSteps}</dd>
                </div>
                <div>
                  <dt>Multiplier</dt>
                  <dd className="numeric">{formatMultiplier(view.multiplier)}</dd>
                </div>
                <div>
                  <dt>Cash out</dt>
                  <dd className="numeric">{formatChips(view.payout)}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      }
      controls={
        <div className="hilo__controls">
          {!live ? (
            <button
              className="btn btn--primary hilo__wide"
              onClick={start}
              disabled={busy || bet > balance || bet < 1}
            >
              {busy ? 'Dealing…' : `Deal for ${formatChips(bet)}`}
            </button>
          ) : (
            <>
              {/*
                * The odds are quoted on the buttons before the player commits.
                * The server sends both, so the numbers on screen are the numbers it
                * will pay rather than a second calculation that could disagree.
                */}
              <div className="hilo__guesses">
                {(['higher', 'lower'] as const).map((choice) => (
                  <button
                    key={choice}
                    className={`btn btn--primary hilo__guess is-${choice}`}
                    onClick={() => make(choice)}
                    disabled={busy || view.capped}
                  >
                    <span className="hilo__guess-name">
                      {choice === 'higher' ? '▲ Higher or same' : '▼ Lower or same'}
                    </span>
                    <span className="hilo__guess-odds numeric">
                      {formatMultiplier(view.odds[choice].multiplier)}
                      {' · '}
                      {(view.odds[choice].chance * 100).toFixed(1)}%
                    </span>
                  </button>
                ))}
              </div>

              <button
                className="btn btn--ghost hilo__wide"
                onClick={cashOut}
                disabled={busy || view.steps === 0}
              >
                {view.steps === 0
                  ? 'Make a guess first'
                  : `Take ${formatChips(view.payout)}`}
              </button>

              {view.capped && (
                <p className="hilo__note">
                  That is as far as a streak runs — cash out to collect.
                </p>
              )}
            </>
          )}

          {error && <p className="hilo__error">{error}</p>}

          {view !== null && (
            <p className="hilo__note">
              Both choices win on a tie, so their chances add up to more than 100%. That
              overlap is deliberate: the alternative is a third outcome that loses and
              that neither button covers.
            </p>
          )}
        </div>
      }
    />
  );
}
