import {
  colourOf, labelFor, numbersFor, payoutOdds, RED_NUMBERS, WHEEL_ORDER,
  type BetSpec, type BetType, type RouletteDetail,
} from '@websino/engine';
import { useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './RouletteGame.css';

/** The chip denominations you can drop on the felt. */
const CHIPS = [1, 5, 25, 100] as const;

/**
 * How long a spin runs, and what happens during it.
 *
 * The wheel used to snap: the result arrived and the canvas was redrawn once, already
 * stopped, with the ball sitting in the winning pocket. That is a *diagram* of a spin.
 * Roulette is one of the few games whose entire appeal is the four seconds between the
 * bet and the answer, so those four seconds are now actually spent.
 *
 * `BALL_DROP` is the fraction of the spin at which the ball leaves the track and falls
 * into the pockets. Everything after it is the ball riding round in its pocket while the
 * wheel brakes - which is the part that makes the landing look decided by the wheel
 * rather than assigned to it.
 */
const SPIN_MS = 4_400;
const WHEEL_TURNS = 6;
const BALL_TURNS = 11;
const BALL_DROP = 0.8;

/** Where the ball runs while the wheel is fast, and where it comes to rest. */
const TRACK_R = 0.835;
const POCKET_R = 0.645;

/** Decelerations. The ball slows harder than the wheel, so it is caught rather than lost. */
const wheelEase = (t: number): number => 1 - (1 - t) ** 3.6;
const ballEase = (t: number): number => 1 - (1 - t) ** 2.6;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The whole wheel, at one instant.
 *
 * Pulled out of the effect that used to own it so it can be called sixty times a second
 * with a different `rotation` rather than once with none. Radii are fractions of the outer
 * edge, which is the entire geometry of the thing:
 *
 *   1.00-0.88  rim, the turned wooden edge
 *   0.88-0.79  ball track, where the ball runs before it drops
 *   0.79-0.50  pockets, with a fret between each
 *   0.50-0.15  cone, the polished slope down to the middle
 *   0.15-0     turret
 *
 * `rotation` is added to the angle of every pocket, and is zero when the winning pocket is
 * at twelve o'clock. So the drawing cannot disagree with the result: there is exactly one
 * rotation at which the wheel is at rest, and it is the one that puts the server's number
 * under the ball.
 */
function drawWheel(
  context: CanvasRenderingContext2D,
  size: number,
  state: {
    winner: RouletteDetail | null;
    rotation: number;
    ballAngle: number;
    ballRadius: number;
    /** Angle covered since the previous frame, which is what the ball's smear is drawn from. */
    ballSpeed: number;
    /** The winning number on the turret - held back until the wheel has stopped. */
    showNumber: boolean;
  },
): void {
  const { winner, rotation, ballAngle, ballRadius, ballSpeed, showNumber } = state;
  const centre = size / 2;
  const outer = centre - 2;
  const step = (Math.PI * 2) / WHEEL_ORDER.length;
  const offset =
    (winner ? -winner.pocketIndex * step - step / 2 - Math.PI / 2 : -Math.PI / 2) + rotation;

  context.clearRect(0, 0, size, size);

  const ring = (from: number, to: number, fill: string | CanvasGradient): void => {
    context.beginPath();
    context.arc(centre, centre, outer * to, 0, Math.PI * 2);
    context.arc(centre, centre, outer * from, 0, Math.PI * 2, true);
    context.fillStyle = fill;
    context.fill('evenodd');
  };

  // The rim, lit from the top-left so the whole wheel reads as a solid object.
  const rim = context.createLinearGradient(0, 0, size, size);
  rim.addColorStop(0, '#f7e080');
  rim.addColorStop(0.35, '#a5842f');
  rim.addColorStop(0.62, '#6b551e');
  rim.addColorStop(1, '#d4af37');
  ring(0.88, 1, rim);

  // The ball track: polished, and darker at the bottom where the rim shades it.
  const track = context.createLinearGradient(0, 0, 0, size);
  track.addColorStop(0, '#3c2c1c');
  track.addColorStop(0.5, '#241a10');
  track.addColorStop(1, '#150f09');
  ring(TRACK_R - 0.045, 0.88, track);

  WHEEL_ORDER.forEach((number, index) => {
    const start = index * step + offset;
    context.beginPath();
    context.arc(centre, centre, outer * 0.79, start, start + step);
    context.arc(centre, centre, outer * 0.5, start + step, start, true);
    context.closePath();
    context.fillStyle =
      number === 0 ? '#1e7a4f' : RED_NUMBERS.has(number) ? '#b22a2a' : '#17191d';
    context.fill();

    // The fret: the metal divider standing between one pocket and the next.
    context.beginPath();
    context.moveTo(
      centre + Math.cos(start) * outer * 0.5,
      centre + Math.sin(start) * outer * 0.5,
    );
    context.lineTo(
      centre + Math.cos(start) * outer * 0.79,
      centre + Math.sin(start) * outer * 0.79,
    );
    context.strokeStyle = 'rgb(212 175 55 / 55%)';
    context.lineWidth = Math.max(1, size * 0.004);
    context.stroke();

    // The number, standing upright out of the middle of its own pocket.
    context.save();
    context.translate(centre, centre);
    context.rotate(start + step / 2 + Math.PI / 2);
    context.fillStyle = '#f2efe4';
    /*
     * Set out near the rim, and small.
     *
     * A pocket is a wedge, so the room for a number grows with the radius: at 0.655
     * the arc between two frets is barely wider than a two-digit number and adjacent
     * numbers touched. 0.70 buys most of the difference, and dropping the size the
     * rest of the way keeps 10 through 36 clear of their neighbours.
     */
    context.font = `650 ${Math.max(7, Math.round(size * 0.038))}px "Inter Variable", system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(number), 0, -outer * 0.7);
    context.restore();
  });

  // The cone: a polished slope, so the middle is not a flat hole.
  const cone = context.createRadialGradient(
    centre - outer * 0.12, centre - outer * 0.16, outer * 0.04,
    centre, centre, outer * 0.5,
  );
  cone.addColorStop(0, '#2b6b52');
  cone.addColorStop(0.55, '#14442f');
  cone.addColorStop(1, '#0a2a1d');
  ring(0, 0.5, cone);

  /*
   * The four diamonds on the cone.
   *
   * They turn with the wheel, which is what gives the middle of it a sense of rotation -
   * a plain cone under a spinning pocket ring looks like a still photograph with a moving
   * border, because there is nothing on it for the eye to track.
   */
  for (let i = 0; i < 4; i += 1) {
    const at = offset + (i * Math.PI) / 2;
    context.save();
    context.translate(centre + Math.cos(at) * outer * 0.36, centre + Math.sin(at) * outer * 0.36);
    context.rotate(at);
    context.beginPath();
    context.moveTo(outer * 0.055, 0);
    context.lineTo(0, outer * 0.032);
    context.lineTo(-outer * 0.055, 0);
    context.lineTo(0, -outer * 0.032);
    context.closePath();
    context.fillStyle = 'rgb(212 175 55 / 72%)';
    context.fill();
    context.restore();
  }

  // The turret, and the winning number printed on it.
  const turret = context.createLinearGradient(
    centre - outer * 0.16, centre - outer * 0.16,
    centre + outer * 0.16, centre + outer * 0.16,
  );
  turret.addColorStop(0, '#f7e080');
  turret.addColorStop(0.5, '#a5842f');
  turret.addColorStop(1, '#e6c75a');
  ring(0, showNumber ? 0.2 : 0.13, turret);

  context.beginPath();
  context.arc(centre, centre, outer * 0.5, 0, Math.PI * 2);
  context.strokeStyle = 'rgb(212 175 55 / 70%)';
  context.lineWidth = Math.max(1, size * 0.005);
  context.stroke();

  if (showNumber && winner) {
    context.fillStyle = '#1a1305';
    context.font = `750 ${Math.round(size * 0.1)}px "Inter Variable", system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(String(winner.number), centre, centre);
  }

  /*
   * The ball, and the smear it leaves at speed.
   *
   * Six ghosts spaced by the angle actually covered since the last frame, so the smear is
   * long while the ball is flying and gone by the time it drops. Faking it with a fixed
   * length would have the ball still trailing after it had stopped, which reads as a bug
   * rather than as motion.
   */
  const radius = size * 0.026;
  for (let i = 6; i >= 0; i -= 1) {
    const at = ballAngle - ballSpeed * i * 0.7;
    const x = centre + Math.cos(at) * outer * ballRadius;
    const y = centre + Math.sin(at) * outer * ballRadius;
    if (i > 0) {
      context.beginPath();
      context.arc(x, y, radius * (1 - i * 0.07), 0, Math.PI * 2);
      context.fillStyle = `rgb(240 238 228 / ${Math.max(0, 26 - i * 4)}%)`;
      context.fill();
      continue;
    }
    const ball = context.createRadialGradient(
      x - size * 0.008, y - size * 0.008, size * 0.002, x, y, radius,
    );
    ball.addColorStop(0, '#ffffff');
    ball.addColorStop(0.6, '#d8d4c6');
    ball.addColorStop(1, '#8d8a7e');
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = ball;
    context.shadowColor = 'rgb(0 0 0 / 55%)';
    context.shadowBlur = size * 0.02;
    context.shadowOffsetY = size * 0.006;
    context.fill();
    context.shadowColor = 'transparent';
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;
  }
}

/** Numbers in felt order: three rows of twelve, 1-36 running left to right. */
const ROWS: number[][] = [2, 1, 0].map((offset) =>
  Array.from({ length: 12 }, (_, column) => column * 3 + 3 - offset),
);

const key = (spec: BetSpec): string => `${spec.type}:${spec.selection.join(',')}`;

export function RouletteGame({
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
  const [chip, setChip] = useState<number>(5);
  const [bets, setBets] = useState<BetSpec[]>([]);
  const [spinning, setSpinning] = useState(false);
  const [last, setLast] = useState<RouletteDetail | null>(null);
  /**
   * Whether the answer may be shown yet.
   *
   * The result arrives long before the wheel finishes turning, and everything that reads
   * off it - the big number, the lit spots on the felt, the settled bets - is a spoiler
   * until the ball has actually landed. The balance is deliberately not on this list: a
   * number that is briefly ahead of the wheel beats one that is briefly wrong if the
   * player leaves the screen mid-spin.
   */
  const [revealed, setRevealed] = useState(true);
  const [recent, setRecent] = useState<number[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * The result whose spin has already been watched.
   *
   * A ref rather than state because the canvas effect both reads and writes it, and
   * writing it must not cause a render - a render would re-run the effect and spin the
   * same result a second time. It exists so that a re-render from any other cause (a chip
   * picked up, the window resized) redraws the wheel at rest instead of replaying it.
   */
  const revealedRef = useRef<RouletteDetail | null>(null);

  const staked = bets.reduce((sum, b) => sum + b.amount, 0);

  const place = (type: BetType, selection: number[] = []): void => {
    if (spinning) return;
    if (staked + chip > balance) {
      setError('Not enough chips for that bet');
      return;
    }
    setError(null);
    const spec: BetSpec = { type, selection, amount: chip };
    setBets((prev) => {
      const index = prev.findIndex((b) => key(b) === key(spec));
      if (index < 0) return [...prev, spec];
      const next = [...prev];
      next[index] = { ...(next[index] as BetSpec), amount: (next[index] as BetSpec).amount + chip };
      return next;
    });
  };

  const clearSpot = (type: BetType, selection: number[] = []): void => {
    if (spinning) return;
    const id = key({ type, selection, amount: 0 });
    setBets((prev) => prev.filter((b) => key(b) !== id));
  };

  const amountOn = (type: BetType, selection: number[] = []): number => {
    const id = key({ type, selection, amount: 0 });
    return bets.find((b) => key(b) === id)?.amount ?? 0;
  };

  const settle = useRef<number | null>(null);
  useEffect(() => () => { if (settle.current) window.clearTimeout(settle.current); }, []);

  const spin = async (): Promise<void> => {
    if (spinning || bets.length === 0 || staked > balance) return;
    setSpinning(true);
    setRevealed(false);
    setError(null);
    try {
      const result = await transport.play({ game: 'roulette', bet: staked, config: { bets } });
      const detail = result.detail as RouletteDetail;
      setLast(detail);
      onBalance(result.balance);

      if (settle.current) window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => {
        setRevealed(true);
        setSpinning(false);
        setRecent((prev) => [detail.number, ...prev].slice(0, 12));
        setHistory((prev) => [
          {
            id: Date.now() + Math.random(),
            label: `${detail.number} ${detail.colour}`,
            won: result.payout > staked,
            net: result.payout - staked,
          },
          ...prev,
        ]);
      }, SPIN_MS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
      setRevealed(true);
      setSpinning(false);
    }
  };

  /*
   * The wheel: a canvas, because 37 rotating wedges as DOM would be absurd.
   *
   * Keyed on `last`, so every new result runs the spin exactly once. The rotation is
   * presentation over an outcome the server already picked - it is computed *backwards*
   * from the winning pocket, and the only thing the easing controls is how long the player
   * waits to find out. There is no path through this that could land somewhere else.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const atRest = {
      winner: last,
      rotation: 0,
      ballAngle: -Math.PI / 2,
      ballRadius: last ? POCKET_R : TRACK_R,
      ballSpeed: 0,
      showNumber: last !== null,
    };

    // Nothing has been spun, or this result has already been watched land.
    if (!last || revealedRef.current === last) {
      drawWheel(context, size, atRest);
      return;
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced) {
      drawWheel(context, size, atRest);
      return;
    }

    const full = WHEEL_TURNS * Math.PI * 2;
    const started = performance.now();
    let frame = 0;

    /** The wheel's angle at `t`, arriving at zero - the winner under twelve o'clock. */
    const rotationAt = (t: number): number => full * (1 - wheelEase(t));

    /**
     * The ball's angle at `t`, running the other way round the track.
     *
     * Up to the drop it is closing on the pocket's position *at the moment of the drop*,
     * not on the pocket's final position - so when it arrives there is nothing to correct.
     * After the drop it simply is the pocket, and rides the wheel down to a stop.
     */
    const caught = rotationAt(BALL_DROP);
    const ballAt = (t: number): number =>
      t >= BALL_DROP
        ? -Math.PI / 2 + rotationAt(t)
        : -Math.PI / 2 + caught
          + BALL_TURNS * Math.PI * 2 * (ballEase(clamp01(t / BALL_DROP)) - 1);

    const radiusAt = (t: number): number => {
      // Lifted off its resting pocket and back onto the track as the wheel takes off.
      if (t < 0.06) return POCKET_R + (TRACK_R - POCKET_R) * smooth(t / 0.06);
      if (t < 0.58) return TRACK_R;
      if (t >= BALL_DROP) return POCKET_R;
      // Falling: down the slope, with two shrinking bounces off the frets on the way.
      const fall = smooth((t - 0.58) / (BALL_DROP - 0.58));
      const bounce = 0.035 * Math.abs(Math.sin(Math.PI * 3 * fall)) * (1 - fall);
      return TRACK_R + (POCKET_R - TRACK_R) * fall + bounce;
    };

    const tick = (now: number): void => {
      const t = clamp01((now - started) / SPIN_MS);
      const angle = ballAt(t);
      drawWheel(context, size, {
        winner: last,
        rotation: rotationAt(t),
        ballAngle: angle,
        ballRadius: radiusAt(t),
        ballSpeed: angle - ballAt(Math.max(0, t - 1 / 60)),
        // The turret keeps the answer until the wheel has actually stopped.
        showNumber: t >= 1,
      });
      if (t < 1) frame = requestAnimationFrame(tick);
      else revealedRef.current = last;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [last]);

  /** The result, once the wheel has stopped. Everything that could spoil it reads this. */
  const shown = revealed ? last : null;

  const winningNumbers = new Set(
    shown?.bets.filter((b) => b.won).flatMap((b) => b.numbers) ?? [],
  );

  const Spot = ({
    type, selection = [], children, className = '',
  }: {
    type: BetType;
    selection?: number[];
    children: React.ReactNode;
    className?: string;
  }) => {
    const amount = amountOn(type, selection);
    return (
      <button
        className={`felt__spot ${className}${amount ? ' has-chips' : ''}`}
        onClick={() => place(type, selection)}
        onContextMenu={(event) => { event.preventDefault(); clearSpot(type, selection); }}
        disabled={spinning}
        title={`${labelFor({ type, selection, amount: 0 })} — pays ${payoutOdds(numbersFor({ type, selection, amount: 0 }).length)}:1`}
      >
        {children}
        {amount > 0 && <span className="felt__chip numeric">{amount}</span>}
      </button>
    );
  };

  return (
    <GameShell
      title="Roulette"
      subtitle="Single zero · every bet on the felt returns exactly 36/37"
      transport={transport}
      balance={balance}
      bet={staked}
      onBetChange={() => { /* the stake is whatever is on the felt */ }}
      disabled={spinning}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="roulette">
          <div className="roulette__top">
            <canvas
              ref={canvasRef}
              className={`roulette__wheel${spinning ? ' is-spinning' : ''}`}
              aria-hidden="true"
            />
            <div className="roulette__readout">
              <output
                // Re-keyed per result, so a repeat of the same number still lands visibly.
                key={shown ? `${shown.number}-${recent.length}` : 'none'}
                className={`roulette__number is-${shown ? shown.colour : 'none'}${spinning ? ' is-waiting' : ''}`}
              >
                {shown ? shown.number : spinning ? '…' : '—'}
              </output>
              {recent.length > 0 && (
                <ul className="roulette__recent" aria-label="Recent numbers">
                  {recent.map((n, i) => (
                    <li key={i} className={`is-${colourOf(n)}`}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="felt">
            <Spot type="straight" selection={[0]} className="felt__zero">0</Spot>

            <div className="felt__numbers">
              {ROWS.map((row, rowIndex) => (
                <div className="felt__row" key={rowIndex}>
                  {row.map((n) => (
                    <Spot
                      key={n}
                      type="straight"
                      selection={[n]}
                      className={`felt__number is-${colourOf(n)}${winningNumbers.has(n) ? ' is-winner' : ''}${shown?.number === n ? ' is-drawn' : ''}`}
                    >
                      {n}
                    </Spot>
                  ))}
                  <Spot type="column" selection={[2 - rowIndex]} className="felt__outside">
                    2:1
                  </Spot>
                </div>
              ))}
            </div>

            <div className="felt__dozens">
              {[0, 1, 2].map((d) => (
                <Spot key={d} type="dozen" selection={[d]} className="felt__outside">
                  {d * 12 + 1}–{d * 12 + 12}
                </Spot>
              ))}
            </div>

            <div className="felt__evens">
              <Spot type="low" className="felt__outside">1–18</Spot>
              <Spot type="even" className="felt__outside">Even</Spot>
              <Spot type="red" className="felt__outside felt__outside--red">Red</Spot>
              <Spot type="black" className="felt__outside felt__outside--black">Black</Spot>
              <Spot type="odd" className="felt__outside">Odd</Spot>
              <Spot type="high" className="felt__outside">19–36</Spot>
            </div>
          </div>
        </div>
      }
      controls={
        <div className="roulette__controls">
          <div className="roulette__chips" role="group" aria-label="Chip value">
            {CHIPS.map((value) => (
              <button
                key={value}
                className={`roulette__chip-btn${chip === value ? ' is-active' : ''}`}
                onClick={() => setChip(value)}
                disabled={spinning}
              >
                {value}
              </button>
            ))}
          </div>

          <p className="roulette__staked">
            <span>On the felt</span>
            <strong className="numeric">{formatChips(staked)}</strong>
          </p>

          <p className="roulette__hint">
            Click a spot to add a chip, right-click to clear it. Every bet type returns
            exactly 36/37 — the zero is the entire house edge.
          </p>

          {error && <p className="roulette__error">{error}</p>}

          <button
            className="btn btn--primary roulette__action"
            onClick={() => void spin()}
            disabled={spinning || bets.length === 0 || staked > balance}
          >
            {spinning ? 'Spinning…' : 'Spin'}
          </button>

          <button
            className="btn btn--ghost roulette__action"
            onClick={() => setBets([])}
            disabled={spinning || bets.length === 0}
          >
            Clear the felt
          </button>

          {shown && (
            <ul className="roulette__settled">
              {shown.bets.map((b, i) => (
                <li key={i} className={b.won ? 'is-win' : 'is-loss'}>
                  <span>{b.label}</span>
                  <span className="numeric">
                    {b.won ? `+${formatChips(b.payout - b.amount)}` : `−${formatChips(b.amount)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}
