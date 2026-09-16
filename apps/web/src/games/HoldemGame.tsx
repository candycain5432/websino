import type { Card, HoldemSnapshot, HoldemView } from '@websino/engine';
import { useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { PlayingCard } from '../components/PlayingCard.js';
import { actionTone, type ActionTone } from '../lib/actionTone.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport, HoldemAction } from '../lib/transport.js';
import './HoldemGame.css';

/**
 * How long a bot appears to think, by what it decided.
 *
 * The server resolves every bot between your turns in one loop, so a whole street used to
 * arrive in a single frame: three decisions that each mattered showed up as one jump in
 * the pot, with only the log to say what had happened. The table now walks through the
 * states the server passed through, a seat at a time.
 *
 * The pause is drawn from a range rather than fixed, because three seats pausing for
 * identically 900ms reads as a machine ticking rather than as people playing. And the
 * range depends on the decision: folding is instant in a way that raising is not, so a
 * long pause followed by a raise carries the same weight at this table that it does at a
 * real one. It is theatre - the decision was made before the first frame was drawn - but
 * it is theatre that tells the truth about what happened.
 */
const THINK_MS: Record<ActionTone, readonly [number, number]> = {
  fold: [380, 760],
  passive: [620, 1_180],
  aggressive: [980, 1_850],
  allin: [1_250, 2_100],
  neutral: [560, 980],
};

/** A street turning over is worth a beat of its own, on top of the actor's think. */
const STREET_MS = 520;

function thinkTime(before: HoldemSnapshot, after: HoldemSnapshot): number {
  const seat = before.toAct;
  const label = seat === null
    ? ''
    : after.seats.find((s) => s.seat === seat)?.lastAction ?? '';
  const [low, high] = THINK_MS[actionTone(label)];
  const board = after.board.length > before.board.length ? STREET_MS : 0;
  return low + Math.random() * (high - low) + board;
}

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
  /**
   * The table as it is being *shown*, which during a playback is behind the server.
   *
   * A `HoldemView` is a `HoldemSnapshot` with a trail attached, so an earlier frame
   * renders through exactly the same fields - and carries `yourTurn: false`, which is
   * what stops the controls offering an action against a state the table has already
   * left. There is deliberately no second copy of the final view held alongside this:
   * one source for what is on screen is the whole point.
   */
  const [view, setView] = useState<HoldemSnapshot | null>(null);
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

  /*
   * Playback timers, and whether this screen is still on.
   *
   * A hand can be mid-playback when the player walks back to the lobby, and the pending
   * waits have to stop there - both so the table does not keep drawing itself into a
   * dead component, and so `leave` is not queued behind three seconds of bots thinking.
   */
  const timers = useRef<number[]>([]);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    };
  }, []);

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => { timers.current.push(window.setTimeout(resolve, ms)); });

  /** Walk the states the server passed through, then land on the one it ended at. */
  const play = async (final: HoldemView): Promise<void> => {
    const frames: HoldemSnapshot[] = [...final.steps, final];
    for (let i = 0; i < frames.length; i += 1) {
      const frame = frames[i] as HoldemSnapshot;
      const previous = frames[i - 1];
      if (previous) await wait(thinkTime(previous, frame));
      if (!live.current) return;
      setView(frame);
    }
  };

  const run = async (work: () => Promise<HoldemView>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      const wasInProgress = view?.handInProgress ?? false;
      /*
       * The balance is applied now, ahead of the playback.
       *
       * Same call made everywhere else on the site: a figure that is briefly ahead of the
       * table beats one that is briefly wrong, because leaving the screen mid-playback
       * would otherwise strand a stale number in the header.
       */
      onBalance(next.balance);
      await play(next);
      if (!live.current) return;

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
                          <PlayingCard key={i} card={card} size="sm" dealIndex={i} />
                        ))
                      ) : (
                        <>
                          <PlayingCard faceUp={false} size="sm" dealIndex={0} />
                          <PlayingCard faceUp={false} size="sm" dealIndex={1} />
                        </>
                      )}
                    </div>

                    {s.handDescription && (
                      <span className="seat__hand">{s.handDescription}</span>
                    )}
                    <span className="seat__chips numeric">{formatChips(s.chips)}</span>
                    {s.bet > 0 && <span className="seat__bet numeric">{formatChips(s.bet)}</span>}
                    {/*
                      * Keyed on the action, so React replaces the node each time it
                      * changes and the pop-in animation runs again. Without the key it is
                      * one element whose text quietly mutates - which is exactly how a
                      * bot's raise went by unnoticed.
                      */}
                    {s.lastAction && (
                      <span
                        key={`${s.lastAction}-${s.bet}`}
                        className={`seat__action is-${actionTone(s.lastAction)}`}
                      >
                        {s.lastAction}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div className="holdem__middle">
                <div className="holdem__board">
                  {Array.from({ length: 5 }, (_, i) => {
                    const card = view.board[i];
                    return card === undefined
                      ? <span key={i} className="holdem__slot" />
                      // The flop lands as three; the turn and river arrive alone, and
                      // their index still gives them a beat before they appear.
                      : <PlayingCard key={i} card={card} size="md" dealIndex={i % 3} />;
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
              {view.result !== null && view.result.rake > 0 && (
                <div>
                  <dt>House took</dt>
                  <dd className="numeric">{formatChips(view.result.rake)}</dd>
                </div>
              )}
            </dl>
          )}

          {seated && view.log.length > 0 && (
            <div className="holdem__log">
              <h2>This hand</h2>
              <HandFeed log={view.log} />
            </div>
          )}

          {seated && <p className="holdem__keys"><kbd>F</kbd> fold · <kbd>C</kbd> call · <kbd>R</kbd> raise</p>}
        </div>
      }
    />
  );
}

/**
 * The hand as it happened, arriving line by line.
 *
 * Against bots, every action between your turns resolves inside a single request - you
 * press Call and the server plays three bots, deals the flop and hands back the finished
 * position. The log is the only record that any of it happened, and as a block of four
 * lines appearing at once it reads as a wall of text rather than as a sequence.
 *
 * So the lines that are *new since the last render* cascade in, about a tenth of a second
 * apart. Nothing is delayed or withheld - the state is already correct the instant it
 * arrives, and this only staggers how the words appear - but it turns "three things
 * happened" into three things you watched happen.
 *
 * The count is tracked in a ref rather than state on purpose: writing it during render
 * would schedule another render, and this needs to compare against the previous one, not
 * cause a new one.
 */
function HandFeed({ log }: { log: string[] }) {
  const seen = useRef(0);
  const firstNew = Math.max(seen.current, 0);
  seen.current = log.length;

  const visible = log.slice(-8);
  const offset = log.length - visible.length;

  return (
    <ol>
      {visible.map((line, i) => {
        const absolute = offset + i;
        const isNew = absolute >= firstNew;
        return (
          <li
            // Keyed by position *and* text: a line that did not change keeps its node and
            // does not re-animate, while a genuinely new one mounts and does.
            key={`${absolute}:${line}`}
            className={isNew ? 'is-new' : ''}
            style={isNew ? { animationDelay: `${(absolute - firstNew) * 110}ms` } : undefined}
          >
            {line}
          </li>
        );
      })}
    </ol>
  );
}
