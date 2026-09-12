import type { Card, HoldemView } from '@websino/engine';
import { useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport, HoldemAction } from '../lib/transport.js';
import './HoldemGame.css';

const STREET_LABELS: Record<string, string> = {
  preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', complete: 'Hand over',
};

const ACTION_LABELS: Record<HoldemAction, string> = {
  fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise',
};

/** Keyboard shortcuts, matching pysino's. */
const ACTION_KEYS: Record<string, HoldemAction> = { f: 'fold', c: 'call', r: 'raise' };

export function HoldemGame({
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
  const [buyIn, setBuyIn] = useState(500);
  const [view, setView] = useState<HoldemView | null>(null);
  const [raiseTo, setRaiseTo] = useState(0);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * The stack at the moment the hand was dealt. The history line has to measure the
   * whole hand, not the last action - blinds are posted before you ever act, so
   * comparing across a single request reports a loss of nothing.
   */
  const [handStartStack, setHandStartStack] = useState<number | null>(null);

  // The buy-in is already spent, so a table in progress has to come back on reload.
  useEffect(() => {
    void transport.holdem.status()
      .then((existing) => { if (existing) setView(existing); })
      .catch(() => { /* not seated */ });
  }, [transport]);

  const seated = view !== null;
  const you = view?.seats[view.you];

  // Keep the raise slider inside what the rules allow as the hand moves.
  useEffect(() => {
    if (!view?.yourTurn) return;
    setRaiseTo((current) =>
      Math.min(Math.max(current || view.minRaiseTo, view.minRaiseTo), view.maxRaiseTo),
    );
  }, [view]);

  const run = async (work: () => Promise<HoldemView>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      const wasInProgress = view?.handInProgress ?? false;
      setView(next);
      onBalance(next.balance);

      // A new hand just started: remember the stack it started from.
      if (next.handInProgress && !wasInProgress) {
        const stack = next.seats[next.you]?.chips ?? 0;
        const committed = next.seats[next.you]?.committed ?? 0;
        setHandStartStack(stack + committed);
      }

      // A finished hand is one line of history: what the seat won or lost over the
      // whole hand, blinds included.
      if (!next.handInProgress && next.result && handStartStack !== null) {
        const net = (next.seats[next.you]?.chips ?? handStartStack) - handStartStack;
        setHandStartStack(null);
        setHistory((prev) => [
          {
            id: Date.now() + Math.random(),
            label: next.result?.wentToShowdown
              ? next.seats[next.you]?.handDescription ?? 'Showdown'
              : net > 0 ? 'Took it uncontested' : 'Folded',
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

  const sit = (): void => void run(() => transport.holdem.sit(buyIn));
  const deal = (): void => void run(() => transport.holdem.deal());
  const act = (action: HoldemAction): void =>
    void run(() => transport.holdem.act(action, action === 'raise' || action === 'bet' ? raiseTo : 0));

  const leave = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { balance: next } = await transport.holdem.leave();
      onBalance(next);
      setView(null);
      setHistory([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (busy || !view?.yourTurn || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const action = ACTION_KEYS[event.key.toLowerCase()];
      if (action && view.actions.includes(action)) {
        event.preventDefault();
        act(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <GameShell
      title="Texas Hold'em"
      subtitle="No-limit against Monte Carlo bots · real side pots"
      transport={transport}
      balance={balance}
      bet={buyIn}
      onBetChange={setBuyIn}
      disabled={busy || seated}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="holdem">
          {!seated ? (
            <div className="holdem__empty">
              <h2>Take a seat</h2>
              <p>
                Three bots with distinct personalities — a Rock, a Maniac, a Calling
                Station and friends. Your buy-in leaves your balance when you sit and
                comes back, plus or minus, when you stand up.
              </p>
            </div>
          ) : (
            <>
              <div className="holdem__seats">
                {view.seats.map((s) => (
                  <div
                    key={s.seat}
                    className={[
                      'seat',
                      s.seat === view.you ? 'is-you' : '',
                      s.isTurn ? 'is-turn' : '',
                      s.folded ? 'is-folded' : '',
                      s.sittingOut ? 'is-out' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className="seat__head">
                      <span className="seat__name">{s.name}</span>
                      {s.isButton && <span className="seat__button" title="Dealer button">D</span>}
                    </div>
                    {s.style && <span className="seat__style">{s.style}</span>}

                    <div className="seat__cards">
                      {s.sittingOut ? (
                        <span className="seat__sitting-out">sitting out</span>
                      ) : s.hole ? (
                        s.hole.map((card: Card, i) => (
                          <PlayingCard key={i} card={card} size="sm" />
                        ))
                      ) : (
                        <>
                          <PlayingCard faceUp={false} size="sm" />
                          <PlayingCard faceUp={false} size="sm" />
                        </>
                      )}
                    </div>

                    {s.handDescription && (
                      <span className="seat__hand">{s.handDescription}</span>
                    )}
                    <span className="seat__chips numeric">{formatChips(s.chips)}</span>
                    {s.bet > 0 && <span className="seat__bet numeric">{formatChips(s.bet)}</span>}
                    {s.lastAction && <span className="seat__action">{s.lastAction}</span>}
                  </div>
                ))}
              </div>

              <div className="holdem__middle">
                <div className="holdem__board">
                  {Array.from({ length: 5 }, (_, i) => {
                    const card = view.board[i];
                    return card === undefined
                      ? <span key={i} className="holdem__slot" />
                      : <PlayingCard key={i} card={card} size="md" />;
                  })}
                </div>
                <div className="holdem__pot">
                  <span className="holdem__street">{STREET_LABELS[view.street] ?? view.street}</span>
                  <strong className="numeric">{formatChips(view.pot)}</strong>
                </div>
              </div>
            </>
          )}
        </div>
      }
      controls={
        <div className="holdem__controls">
          {!seated ? (
            <button
              className="btn btn--primary holdem__action"
              onClick={sit}
              disabled={busy || buyIn > balance || buyIn < 1}
            >
              {busy ? 'Sitting…' : `Sit down for ${formatChips(buyIn)}`}
            </button>
          ) : view.yourTurn ? (
            <>
              <div className="holdem__buttons">
                {view.actions.map((action) => (
                  <button
                    key={action}
                    className={`btn ${action === 'fold' ? 'btn--ghost' : 'btn--primary'}`}
                    onClick={() => act(action as HoldemAction)}
                    disabled={busy}
                  >
                    {ACTION_LABELS[action as HoldemAction]}
                    {action === 'call' && view.toCall > 0 && ` ${formatChips(view.toCall)}`}
                  </button>
                ))}
              </div>

              {(view.actions.includes('raise') || view.actions.includes('bet')) && (
                <label className="holdem__raise">
                  <span>
                    {view.actions.includes('bet') ? 'Bet to' : 'Raise to'}
                    <strong className="numeric">{formatChips(raiseTo)}</strong>
                  </span>
                  <input
                    type="range"
                    min={view.minRaiseTo}
                    max={view.maxRaiseTo}
                    value={raiseTo}
                    disabled={busy}
                    onChange={(event) => setRaiseTo(Number(event.target.value))}
                  />
                </label>
              )}
            </>
          ) : view.handInProgress ? (
            <p className="holdem__waiting">
              Waiting for {view.toAct !== null ? view.seats[view.toAct]?.name : 'the table'}…
            </p>
          ) : (
            <>
              <button
                className="btn btn--primary holdem__action"
                onClick={deal}
                disabled={busy || (you?.chips ?? 0) <= 0}
              >
                {(you?.chips ?? 0) <= 0 ? 'Out of chips' : 'Next hand'}
              </button>
              <button
                className="btn btn--ghost holdem__action"
                onClick={() => void leave()}
                disabled={busy}
              >
                Stand up with {formatChips(you?.chips ?? 0)}
              </button>
            </>
          )}

          {error && <p className="holdem__error">{error}</p>}

          {seated && (
            <dl className="holdem__stats">
              <div>
                <dt>Hand</dt>
                <dd className="numeric">{view.handNumber}</dd>
              </div>
              <div>
                <dt>Your stack</dt>
                <dd className="numeric">{formatChips(you?.chips ?? 0)}</dd>
              </div>
            </dl>
          )}

          {seated && view.log.length > 0 && (
            <div className="holdem__log">
              <h2>This hand</h2>
              <ol>
                {view.log.slice(-8).map((line, i) => <li key={i}>{line}</li>)}
              </ol>
            </div>
          )}

          {seated && <p className="holdem__keys"><kbd>F</kbd> fold · <kbd>C</kbd> call · <kbd>R</kbd> raise</p>}
        </div>
      }
    />
  );
}
