import { crash, MULTIPLIER_SCALE, type CrashView } from '@websino/engine';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatHundredths } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './CrashGame.css';

/** How often to ask the server whether the curve has died. */
const POLL_MS = 250;

/** How long the wreckage stays on screen. */
const BLAST_MS = 900;

/**
 * The rungs the chart is ruled at, in hundredths.
 *
 * Not evenly spaced, because the axis is not: the curve spends its first second between
 * 1x and 2x and can end anywhere above 50x, so a fixed interval is either a smear of lines
 * down low or nothing at all up high. These are the numbers a player is actually aiming
 * at, which is the right thing for a chart to be ruled in.
 */
const LADDER = [150, 200, 300, 500, 1_000, 2_000, 5_000, 10_000, 50_000, 100_000];

/** Which colour a past crash point wears on the strip. Under 2x is the common case. */
const band = (point: number): 'low' | 'mid' | 'high' =>
  point < 200 ? 'low' : point < 1_000 ? 'mid' : 'high';

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
  /** Crash points only, for the strip along the top. Never the cash-out. */
  const [recent, setRecent] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const running = view?.state === 'running';

  const record = useCallback((finished: CrashView): void => {
    const payout = finished.payout ?? 0;
    if (finished.crashPoint) {
      setRecent((prev) => [finished.crashPoint as number, ...prev].slice(0, 12));
    }
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

  /**
   * How far through the explosion we are, from 0 to 1.
   *
   * The curve dying is the moment the whole game is about and it used to be a colour
   * change on a line. It gets its own clock because it has to keep animating after the
   * round is over, when nothing else on the screen is changing any more.
   */
  const [blast, setBlast] = useState(0);
  useEffect(() => {
    if (view?.state !== 'crashed') { setBlast(0); return; }
    const started = performance.now();
    let frame = 0;
    const tick = (now: number): void => {
      const t = Math.min(1, (now - started) / BLAST_MS);
      setBlast(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [view]);

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

    const dead = view?.state === 'crashed';
    const cashed = view?.state === 'cashed';
    const shown = dead
      ? (view.crashPoint ?? MULTIPLIER_SCALE)
      : cashed
        ? (view.cashedMultiplier ?? MULTIPLIER_SCALE)
        : multiplier;

    // Both axes track the curve's own progress. Scaling to a fixed horizon instead
    // left the line crawling along the bottom-left corner for the first second.
    const top = Math.max(150, shown * 1.3);
    const reached = crash.tickReaching(shown);
    const span = Math.max(12, Math.ceil(reached * 1.35));

    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;
    const line = dead
      ? token('--lose', '#E24A44')
      : cashed
        ? token('--win', '#5EC878')
        : token('--gold', '#D4AF37');

    // Room on the right for the multiplier labels, and under the curve for the clock.
    const gutter = 40;
    const floor = height - 16;
    const plot = width - gutter;

    const x = (tick: number): number => (tick / span) * plot;
    const y = (value: number): number =>
      floor - ((value - MULTIPLIER_SCALE) / (top - MULTIPLIER_SCALE)) * (floor - 10);

    /*
     * The grid, labelled in multipliers rather than in pixels.
     *
     * A curve with nothing behind it is a shape; the same curve against a ruler is a
     * *reading*. Three seconds in you can see that you are past 2x and closing on 3x,
     * which is the entire decision the game asks you to make and which the old chart
     * left you to infer from the one number above it.
     */
    context.font = '500 10px "Inter Variable", system-ui, sans-serif';
    context.textBaseline = 'middle';
    for (const rung of LADDER) {
      if (rung <= MULTIPLIER_SCALE || rung > top) continue;
      const at = Math.round(y(rung)) + 0.5;
      context.beginPath();
      context.moveTo(0, at);
      context.lineTo(plot, at);
      context.strokeStyle = 'rgb(255 255 255 / 6%)';
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = 'rgb(255 255 255 / 30%)';
      context.textAlign = 'left';
      context.fillText(`${rung / MULTIPLIER_SCALE}×`, plot + 6, at);
    }

    // Seconds down the bottom, so the climb has a pace and not only a height.
    const perSecond = Math.max(1, Math.round(1000 / (view?.tickMs ?? 100)));
    for (let second = 1; second * perSecond <= span; second += 1) {
      const at = Math.round(x(second * perSecond)) + 0.5;
      context.beginPath();
      context.moveTo(at, 0);
      context.lineTo(at, floor);
      context.strokeStyle = 'rgb(255 255 255 / 4%)';
      context.stroke();
      context.fillStyle = 'rgb(255 255 255 / 22%)';
      context.textAlign = 'center';
      context.fillText(`${second}s`, at, floor + 8);
    }

    context.beginPath();
    context.moveTo(0, floor + 0.5);
    context.lineTo(plot, floor + 0.5);
    context.strokeStyle = 'rgb(255 255 255 / 12%)';
    context.stroke();

    /*
     * The target, drawn before the curve reaches it.
     *
     * An auto cash-out is a promise the server has already made, so showing where it sits
     * turns the climb into a race towards a visible line instead of a number you have to
     * keep comparing against in your head.
     */
    if (view?.autoCashOut && view.autoCashOut < top && view.state === 'running') {
      const at = Math.round(y(view.autoCashOut)) + 0.5;
      context.save();
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(0, at);
      context.lineTo(plot, at);
      context.strokeStyle = token('--win', '#5EC878');
      context.globalAlpha = 0.6;
      context.stroke();
      context.restore();
    }

    const trace = (): void => {
      context.beginPath();
      context.moveTo(x(0), y(MULTIPLIER_SCALE));
      for (let tick = 1; tick <= reached; tick += 1) {
        context.lineTo(x(tick), y(crash.multiplierAtTick(tick)));
      }
    };

    // The area under the curve, which is what gives it mass rather than outline.
    const fill = context.createLinearGradient(0, 0, 0, floor);
    fill.addColorStop(0, `${line}55`);
    fill.addColorStop(1, `${line}00`);
    context.save();
    trace();
    context.lineTo(x(reached), floor);
    context.lineTo(x(0), floor);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.restore();

    /*
     * The curve, lit.
     *
     * Two passes: a wide soft stroke that is the glow, then the line itself over it.
     * `shadowBlur` alone would blur the line rather than surround it.
     */
    context.save();
    context.lineJoin = 'round';
    context.lineCap = 'round';
    trace();
    context.strokeStyle = line;
    context.globalAlpha = 0.22;
    context.lineWidth = 9;
    context.stroke();
    context.globalAlpha = 1;
    trace();
    context.lineWidth = 3;
    context.stroke();
    context.restore();

    const headX = x(reached);
    const headY = y(shown);

    if (dead) {
      /*
       * The debris.
       *
       * Directions come from the shard's index rather than from `Math.random`, because a
       * fresh random direction on every frame is not an explosion - it is twelve dots
       * flickering in place. Fixed directions, moving outwards, under gravity.
       */
      const ease = 1 - (1 - blast) ** 2;
      for (let i = 0; i < 14; i += 1) {
        const angle = (i / 14) * Math.PI * 2 + i * 0.7;
        const reach = 26 + (i % 5) * 13;
        const px = headX + Math.cos(angle) * reach * ease;
        const py = headY + Math.sin(angle) * reach * ease + 46 * blast * blast;
        context.beginPath();
        context.arc(px, py, Math.max(0, 3.4 * (1 - blast)), 0, Math.PI * 2);
        context.fillStyle = line;
        context.globalAlpha = 1 - blast;
        context.fill();
      }
      // The flash, which is what makes the first frame of it land.
      context.beginPath();
      context.arc(headX, headY, 10 + 44 * ease, 0, Math.PI * 2);
      context.fillStyle = line;
      context.globalAlpha = Math.max(0, 0.5 * (1 - blast * 1.6));
      context.fill();
      context.globalAlpha = 1;
    } else {
      // The head: a bright core inside a halo, so it reads as the live end of the line.
      context.save();
      context.shadowColor = line;
      context.shadowBlur = 18;
      context.beginPath();
      context.arc(headX, headY, 5.5, 0, Math.PI * 2);
      context.fillStyle = line;
      context.fill();
      context.beginPath();
      context.arc(headX, headY, 2.4, 0, Math.PI * 2);
      context.fillStyle = '#fff';
      context.fill();
      context.restore();
    }

    // Where you got out, kept on the chart next to where it actually died.
    if (cashed && view.crashPoint) {
      context.save();
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(headX, headY);
      context.lineTo(headX, floor);
      context.strokeStyle = token('--win', '#5EC878');
      context.globalAlpha = 0.5;
      context.stroke();
      context.restore();
    }
  }, [multiplier, view, blast]);

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
          {/*
            * The last dozen crash points.
            *
            * Every crash game on the internet has this strip and it is not decoration: it
            * is the only thing on the screen that says what the distribution looks like,
            * and it makes the wait between rounds feel like part of a series rather than
            * like nothing happening.
            */}
          <ul className="crash__recent" aria-label="Recent crash points">
            {recent.map((point, i) => (
              <li key={`${point}-${i}`} className={`crash__tick is-${band(point)}`}>
                {formatHundredths(point)}×
              </li>
            ))}
          </ul>

          <output
            className={[
              'crash__multiplier',
              'numeric',
              view?.state === 'crashed' ? 'is-dead' : '',
              view?.state === 'cashed' ? 'is-cashed' : '',
              running ? 'is-climbing' : '',
            ].filter(Boolean).join(' ')}
          >
            {formatHundredths(display)}×
          </output>

          <canvas
            ref={canvasRef}
            className={`crash__canvas${view?.state === 'crashed' && blast < 1 ? ' is-dead' : ''}`}
            aria-hidden="true"
          />

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
