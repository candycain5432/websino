import { blackjack, type BlackjackView, type Card } from '@websino/engine';
import { useCallback, useEffect, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips } from '../lib/format.js';
import type { BlackjackAction, GameTransport } from '../lib/transport.js';
import './BlackjackGame.css';

const ACTION_LABELS: Record<BlackjackAction, string> = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

/** Keyboard shortcuts, matching pysino's. */
const ACTION_KEYS: Record<string, BlackjackAction> = {
  h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender',
};

const OUTCOME_LABELS: Record<string, string> = {
  blackjack: 'Blackjack!', win: 'Win', push: 'Push', lose: 'Lose',
  bust: 'Bust', surrender: 'Surrendered',
};

export function BlackjackGame({
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
  const [view, setView] = useState<BlackjackView | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<BlackjackAction | null>(null);

  // Pick up a hand that was already in progress - the stake is already spent, so
  // dropping the player back at an empty table would quietly cost them chips.
  useEffect(() => {
    void transport.blackjack.status().then((existing) => {
      if (existing) setView(existing);
    }).catch(() => { /* no table yet */ });
  }, [transport]);

  const apply = useCallback((next: BlackjackView, staked: number): void => {
    setView(next);
    setHint(null);
    onBalance(next.balance);
    if (next.phase === 'done') {
      const net = next.returned - staked;
      setHistory((prev) => [
        {
          id: Date.now() + Math.random(),
          label: next.hands.map((h) => OUTCOME_LABELS[h.outcome ?? ''] ?? h.label).join(', '),
          won: net > 0,
          net,
        },
        ...prev,
      ]);
    }
  }, [onBalance]);

  const run = useCallback(
    async (work: () => Promise<BlackjackView>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const staked = view?.staked ?? bet;
        apply(await work(), staked);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [apply, bet, busy, view],
  );

  const inHand = view !== null && view.phase !== 'done';
  const canDeal = !inHand && bet <= balance && bet >= 1;

  const deal = (): void => void run(() => transport.blackjack.deal(bet));
  const act = (action: BlackjackAction): void =>
    void run(() => transport.blackjack.act(action));
  const insure = (buy: boolean): void =>
    void run(() => transport.blackjack.insurance(buy));

  // Keyboard: the action letters while playing, space to deal the next hand.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (busy || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

      if (event.key === ' ' && canDeal) {
        event.preventDefault();
        deal();
        return;
      }
      const action = ACTION_KEYS[event.key.toLowerCase()];
      if (action && view?.actions.includes(action)) {
        event.preventDefault();
        act(action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /**
   * The hint runs entirely on visible state and touches no random source at all.
   * pysino's equivalent drew from the same generator as the deal, so asking for advice
   * changed the cards it was advising about.
   */
  const askHint = (): void => {
    if (!view || view.phase !== 'player') return;
    const hand = view.hands[view.activeIndex];
    const up = view.dealer[0];
    if (!hand || up === undefined) return;
    setHint(
      blackjack.basicStrategy(
        {
          cards: hand.cards, bet: hand.bet, doubled: hand.doubled, fromSplit: hand.fromSplit,
          splitAces: false, stood: false, surrendered: false, outcome: null, payout: 0,
        },
        up,
        view.actions,
      ),
    );
  };

  const dealerCards: Array<Card | undefined> = view
    ? view.holeHidden
      ? [view.dealer[0], undefined]
      : view.dealer
    : [];

  return (
    <GameShell
      title="Blackjack"
      subtitle="Six decks · dealer stands on soft 17 · blackjack pays 3:2"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy || inHand}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="bj">
          <div className="bj__side">
            <span className="bj__side-label">Dealer</span>
            <div className="bj__cards">
              {dealerCards.length === 0 ? (
                <PlayingCard faceUp={false} size="lg" />
              ) : (
                dealerCards.map((card, i) => (
                  <PlayingCard key={i} card={card} faceUp={card !== undefined} size="lg" />
                ))
              )}
            </div>
            <span className="bj__total numeric">
              {view ? (view.dealerTotal ?? '?') : '—'}
            </span>
          </div>

          <div className="bj__side">
            <span className="bj__side-label">
              You
              {view && view.hands.length > 1 && ` · ${view.hands.length} hands`}
            </span>
            <div className="bj__hands">
              {(view?.hands ?? []).map((hand, index) => (
                <div
                  key={index}
                  className={[
                    'bj__hand',
                    view && view.phase === 'player' && view.activeIndex === index ? 'is-active' : '',
                    hand.outcome ? `is-${hand.outcome}` : '',
                  ].filter(Boolean).join(' ')}
                >
                  <div className="bj__cards">
                    {hand.cards.map((card, i) => (
                      <PlayingCard key={i} card={card} size="lg" />
                    ))}
                  </div>
                  <span className="bj__hand-meta">
                    <span className="numeric">{hand.label}</span>
                    {hand.outcome && (
                      <span className="bj__outcome">{OUTCOME_LABELS[hand.outcome]}</span>
                    )}
                  </span>
                </div>
              ))}
              {!view && (
                <div className="bj__hand">
                  <div className="bj__cards">
                    <PlayingCard faceUp={false} size="lg" />
                    <PlayingCard faceUp={false} size="lg" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {view?.phase === 'done' && (
            <output className={`bj__banner${view.returned > view.staked ? ' is-win' : view.returned === view.staked ? ' is-push' : ' is-loss'}`}>
              {view.returned > view.staked
                ? `+${formatChips(view.returned - view.staked)}`
                : view.returned === view.staked
                  ? 'Push'
                  : `−${formatChips(view.staked - view.returned)}`}
            </output>
          )}
        </div>
      }
      controls={
        <div className="bj__controls">
          {view?.insuranceOffered ? (
            <div className="bj__insurance">
              <p>
                Dealer shows an ace. Insurance costs{' '}
                <strong className="numeric">{formatChips(view.insuranceCost)}</strong> and pays 2:1.
              </p>
              <p className="bj__insurance-note">
                Basic strategy never takes it — it is a side bet on the hole card, and a
                losing one on average.
              </p>
              <div className="bj__actions">
                <button className="btn btn--primary" onClick={() => insure(true)} disabled={busy}>
                  Insure
                </button>
                <button className="btn btn--ghost" onClick={() => insure(false)} disabled={busy}>
                  No thanks
                </button>
              </div>
            </div>
          ) : inHand ? (
            <>
              <div className="bj__actions">
                {(view?.actions ?? []).map((action) => (
                  <button
                    key={action}
                    className={`btn ${action === 'hit' || action === 'stand' ? 'btn--primary' : 'btn--ghost'}${hint === action ? ' is-hinted' : ''}`}
                    onClick={() => act(action)}
                    disabled={busy}
                  >
                    {ACTION_LABELS[action]}
                  </button>
                ))}
              </div>
              <button className="btn btn--ghost bj__hint" onClick={askHint} disabled={busy}>
                {hint ? `Basic strategy: ${ACTION_LABELS[hint]}` : 'Ask for the best play'}
              </button>
            </>
          ) : (
            <button className="btn btn--primary bj__deal" onClick={deal} disabled={busy || !canDeal}>
              {busy ? 'Dealing…' : 'Deal'}
            </button>
          )}

          {error && <p className="bj__error">{error}</p>}

          {view && (
            <dl className="bj__stats">
              <div>
                <dt>In play</dt>
                <dd className="numeric">{formatChips(view.staked)}</dd>
              </div>
              <div>
                <dt>Cards left</dt>
                <dd className="numeric">{view.cardsRemaining}</dd>
              </div>
            </dl>
          )}

          <p className="bj__keys">
            <kbd>H</kbd> hit · <kbd>S</kbd> stand · <kbd>D</kbd> double · <kbd>P</kbd> split ·{' '}
            <kbd>R</kbd> surrender · <kbd>Space</kbd> deal
          </p>
        </div>
      }
    />
  );
}
