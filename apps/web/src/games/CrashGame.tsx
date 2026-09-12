import { crash, MULTIPLIER_SCALE, type CrashView } from '@websino/engine';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatHundredths } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './CrashGame.css';

/** How often to ask the server whether the curve has died. */
const POLL_MS = 250;

export function CrashGame({
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
  const [autoText, setAutoText] = useState('');
  const [view, setView] = useState<CrashView | null>(null);
  const [busy, setBusy] = useState(false);
  const [multiplier, setMultiplier] = useState(MULTIPLIER_SCALE);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const running = view?.state === 'running';

  const record = useCallback((finished: CrashView): void => {
    const payout = finished.payout ?? 0;
    setHistory((prev) => [
      {
        id: Date.now() + Math.random(),
        label:
          finished.state === 'cashed'
            ? `Out at ${formatHundredths(finished.cashedMultiplier ?? 0)}× (died ${formatHundredths(finished.crashPoint ?? 0)}×)`
            : `Died at ${formatHundredths(finished.crashPoint ?? 0)}×`,
        won: payout > finished.bet,
        net: payout - finished.bet,
      },
      ...prev,
    ]);
  }, []);

  // Pick up a round left running by a reload. The stake is already spent, so showing
  // an idle table would quietly lose the player a bet they had paid for.
  useEffect(() => {
    void transport.crash.status().then((existing) => {
      if (!existing) return;
      setView(existing);
      if (existing.state !== 'running') record(existing);
      onBalance(existing.balance);
    }).catch(() => { /* nothing in progress */ });
  }, [transport, record, onBalance]);

  /**
   * The curve is drawn locally from the round's start time, but the *outcome* is never
   * decided here - the client only ever asks the server what happened. Drawing locally
   * keeps the animation smooth over a laggy link; deciding locally would hand the
   * player the crash point.
   */
  useEffect(() => {
    if (!running || !view) return;
    let frame = 0;
    let cancelled = false;

    const tick = (): void => {
      if (cancelled) return;
      const elapsed = Date.now() - view.startedAt;
      setMultiplier(crash.multiplierAtTick(Math.floor(elapsed / view.tickMs)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const poll = window.setInterval(() => {
      void transport.crash.status().then((next) => {
        if (cancelled || !next) return;
        if (next.state !== 'running') {
          setView(next);
          onBalance(next.balance);
          record(next);
        }
      }).catch(() => { /* transient; the next poll will retry */ });
    }, POLL_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearInterval(poll);
    };
  }, [running, view, transport, onBalance, record]);

  // Canvas: the one place in this app where a canvas genuinely beats DOM - a smooth
  // exponential curve redrawn every frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const shown = view?.state === 'crashed'
      ? (view.crashPoint ?? MULTIPLIER_SCALE)
      : view?.state === 'cashed'
        ? (view.cashedMultiplier ?? MULTIPLIER_SCALE)
        : multiplier;

    // Both axes track the curve's own progress. Scaling to a fixed horizon instead
    // left the line crawling along the bottom-left corner for the first second.
    const top = Math.max(150, shown * 1.3);
    const reachedTick = crash.tickReaching(shown);
    const span = Math.max(12, Math.ceil(reachedTick * 1.35));

    const styles = getComputedStyle(canvas);
    const line = view?.state === 'crashed'
      ? styles.getPropertyValue('--lose').trim() || '#E24A44'
      : styles.getPropertyValue('--gold').trim() || '#D4AF37';

    // Baseline.
    context.strokeStyle = 'rgba(255,255,255,0.08)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height - 1);
    context.lineTo(width, height - 1);
    context.stroke();

    const reached = reachedTick;
    const x = (tick: number): number => (tick / span) * width;
    const y = (value: number): number =>
      height - ((value - MULTIPLIER_SCALE) / (top - MULTIPLIER_SCALE)) * (height - 8) - 4;

    context.beginPath();
    context.moveTo(x(0), y(MULTIPLIER_SCALE));
    for (let tick = 1; tick <= reached; tick += 1) {
      context.lineTo(x(tick), y(crash.multiplierAtTick(tick)));
    }

    const fill = context.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, `${line}55`);
    fill.addColorStop(1, `${line}00`);
    context.save();
    context.lineTo(x(reached), height);
    context.lineTo(x(0), height);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.restore();

    context.beginPath();
    context.moveTo(x(0), y(MULTIPLIER_SCALE));
    for (let tick = 1; tick <= reached; tick += 1) {
      context.lineTo(x(tick), y(crash.multiplierAtTick(tick)));
    }
    context.strokeStyle = line;
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.stroke();

    context.beginPath();
    context.arc(x(reached), y(shown), 4, 0, Math.PI * 2);
    context.fillStyle = line;
    context.fill();
  }, [multiplier, view]);

  const parsedAuto = ((): number | null => {
    const text = autoText.trim();
    if (!text) return null;
    const value = Math.round(Number(text) * MULTIPLIER_SCALE);
    return Number.isFinite(value) && value >= 101 ? value : null;
  })();
  const autoInvalid = autoText.trim() !== '' && parsedAuto === null;

  const start = async (): Promise<void> => {
    if (busy || running || bet > balance || autoInvalid) return;
    setBusy(true);
    setError(null);
    try {
      const next = await transport.crash.start(bet, parsedAuto);
      setView(next);
      setMultiplier(MULTIPLIER_SCALE);
      onBalance(next.balance);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const cashOut = async (): Promise<void> => {
    if (busy || !running) return;
    setBusy(true);
    try {
      const next = await transport.crash.cashOut();
      setView(next);
      onBalance(next.balance);
      record(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const display = running
    ? multiplier
    : view?.state === 'cashed'
      ? (view.cashedMultiplier ?? MULTIPLIER_SCALE)
      : (view?.crashPoint ?? MULTIPLIER_SCALE);

  return (
    <GameShell
      title="Crash"
      subtitle="The curve dies at a point drawn before you start · every target is worth the same"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy || running}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="crash">
          <output
            className={[
              'crash__multiplier',
              'numeric',
              view?.state === 'crashed' ? 'is-dead' : '',
              view?.state === 'cashed' ? 'is-cashed' : '',
            ].filter(Boolean).join(' ')}
          >
            {formatHundredths(display)}×
          </output>

          <canvas ref={canvasRef} className="crash__canvas" aria-hidden="true" />

          <p className="crash__status" role="status">
            {running
              ? view?.autoCashOut
                ? `Auto cash-out at ${formatHundredths(view.autoCashOut)}×`
                : 'Cash out before it dies'
              : view?.state === 'cashed'
                ? `Cashed out for ${formatChips(view.payout ?? 0)} — it died at ${formatHundredths(view.crashPoint ?? 0)}×`
                : view?.state === 'crashed'
                  ? `Died at ${formatHundredths(view.crashPoint ?? 0)}×`
                  : 'Place a bet to start the curve'}
          </p>
        </div>
      }
      controls={
        <div className="crash__controls">
          <label className="crash__auto">
            <span>Auto cash-out</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="e.g. 2.00"
              value={autoText}
              disabled={running || busy}
              onChange={(event) => setAutoText(event.target.value)}
              aria-invalid={autoInvalid}
            />
          </label>
          {autoInvalid && <p className="crash__error">Auto cash-out must be 1.01 or higher.</p>}
          <p className="crash__note">
            Set here and the server honours it even if you close the tab — the target is
            part of the round, not a timer running in this browser.
          </p>

          {error && <p className="crash__error">{error}</p>}

          {running ? (
            <button className="btn btn--primary crash__action" onClick={() => void cashOut()} disabled={busy}>
              Cash out {formatChips(Math.floor((bet * multiplier) / MULTIPLIER_SCALE))}
            </button>
          ) : (
            <button
              className="btn btn--primary crash__action"
              onClick={() => void start()}
              disabled={busy || bet > balance || autoInvalid}
            >
              {busy ? 'Starting…' : 'Bet'}
            </button>
          )}

          <p className="crash__note crash__note--dim">
            Cashing out is timed by the server's clock, so a slow connection costs you a
            fraction of a tick rather than letting you reach back in time.
          </p>
        </div>
      }
    />
  );
}
