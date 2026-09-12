import {
  videopoker as vp, type Card, type VideoPokerView,
} from '@websino/engine';
import { useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './VideoPokerGame.css';

const { MAX_COINS, HAND_SIZE, PAY_ORDER, PAYTABLE, HAND_NAMES } = vp;

export function VideoPokerGame({
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
  const [coins, setCoins] = useState(MAX_COINS);
  const [coinValue, setCoinValue] = useState(5);
  const [view, setView] = useState<VideoPokerView | null>(null);
  const [held, setHeld] = useState<boolean[]>(Array<boolean>(HAND_SIZE).fill(false));
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hinted, setHinted] = useState(false);

  // The stake is taken at the deal, so a hand in progress must come back on reload.
  useEffect(() => {
    void transport.videopoker.status().then((existing) => {
      if (!existing) return;
      setView(existing);
      setHeld(existing.held);
    }).catch(() => { /* nothing in progress */ });
  }, [transport]);

  const holding = view?.phase === 'holding';
  const bet = coins * coinValue;

  const run = async (work: () => Promise<VideoPokerView>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      setView(next);
      setHeld(next.held);
      onBalance(next.balance);
      if (next.phase === 'complete') {
        setHistory((prev) => [
          {
            id: Date.now() + Math.random(),
            label: next.resultName ?? 'No pay',
            won: next.payout > next.bet,
            net: next.payout - next.bet,
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

  const deal = (): void => {
    setHinted(false);
    void run(() => transport.videopoker.deal(coins, coinValue));
  };

  const draw = (): void => {
    setHinted(false);
    void run(() => transport.videopoker.draw(held));
  };

  const toggle = (index: number): void => {
    if (!holding || busy) return;
    setHeld((prev) => prev.map((value, i) => (i === index ? !value : value)));
    setHinted(false);
  };

  /**
   * The hint is a pure function of the five cards on the table. It takes `Math.random`
   * for its sampled branches and cannot be handed the fair stream - pysino's equivalent
   * drew from the deal's own generator, so asking for advice changed the draw.
   */
  const askHint = (): void => {
    if (!holding || !view) return;
    setHeld(vp.bestHold(view.cards as Card[]));
    setHinted(true);
  };

  // Keyboard: 1-5 toggle holds, space deals or draws.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (busy || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

      if (event.key >= '1' && event.key <= '5') {
        event.preventDefault();
        toggle(Number(event.key) - 1);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        if (holding) draw();
        else if (bet <= balance) deal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const cards: Array<Card | undefined> = view?.cards ?? Array<undefined>(HAND_SIZE).fill(undefined);

  return (
    <GameShell
      title="Jacks or Better"
      subtitle="Full-pay 9/6 · about 99.5% to a perfect player · the best value in the building"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={(next) => setCoinValue(Math.max(1, Math.floor(next / coins)))}
      disabled={busy || holding}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="vp">
          <div className="vp__hand">
            {cards.map((card, index) => (
              <div key={index} className="vp__slot">
                <button
                  className={`vp__card${held[index] ? ' is-held' : ''}${view && view.drawn.includes(index) ? ' is-new' : ''}`}
                  onClick={() => toggle(index)}
                  disabled={!holding || busy}
                  aria-pressed={held[index]}
                  aria-label={`card ${index + 1}${held[index] ? ', held' : ''}`}
                >
                  <PlayingCard card={card} faceUp={card !== undefined} size="lg" />
                </button>
                <span className={`vp__hold-tag${held[index] ? ' is-on' : ''}`}>
                  {held[index] ? 'HELD' : index + 1}
                </span>
              </div>
            ))}
          </div>

          <output className={`vp__result${view?.payout ? ' is-win' : ''}`}>
            {view === null
              ? 'Deal to play'
              : view.phase === 'holding'
                ? 'Pick what to keep, then draw'
                : view.resultName
                  ? `${view.resultName} — ${formatChips(view.payout)}`
                  : 'No pay'}
          </output>
        </div>
      }
      controls={
        <div className="vp__controls">
          {!holding && (
            <>
              <div className="vp__coins" role="group" aria-label="Coins per hand">
                {Array.from({ length: MAX_COINS }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    className={`vp__coin${coins === n ? ' is-active' : ''}`}
                    onClick={() => setCoins(n)}
                    disabled={busy}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="vp__maxnote">
                The royal pays 250 per coin at one through four, and{' '}
                <strong>800 per coin at five</strong>. That jump is the only reason to bet
                max — and it is a real one.
              </p>
            </>
          )}

          {error && <p className="vp__error">{error}</p>}

          {holding ? (
            <>
              <button className="btn btn--primary vp__action" onClick={draw} disabled={busy}>
                Draw
              </button>
              <button className="btn btn--ghost vp__action" onClick={askHint} disabled={busy}>
                {hinted ? 'Holds set to the best play' : 'Ask for the best play'}
              </button>
            </>
          ) : (
            <button
              className="btn btn--primary vp__action"
              onClick={deal}
              disabled={busy || bet > balance}
            >
              {busy ? 'Dealing…' : `Deal · ${formatChips(bet)}`}
            </button>
          )}

          <table className="vp__paytable">
            <thead>
              <tr>
                <th scope="col">Hand</th>
                {Array.from({ length: MAX_COINS }, (_, i) => (
                  <th key={i} scope="col" className={coins === i + 1 ? 'is-active' : ''}>
                    {i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PAY_ORDER.map((hand) => (
                <tr key={hand} className={view?.result === hand ? 'is-hit' : ''}>
                  <th scope="row">{HAND_NAMES[hand]}</th>
                  {PAYTABLE[hand].map((pay, i) => (
                    <td key={i} className={`numeric${coins === i + 1 ? ' is-active' : ''}`}>
                      {pay}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          <p className="vp__keys">
            <kbd>1</kbd>–<kbd>5</kbd> hold · <kbd>Space</kbd> deal / draw
          </p>
        </div>
      }
    />
  );
}
