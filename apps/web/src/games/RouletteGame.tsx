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
  const [recent, setRecent] = useState<number[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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

  const spin = async (): Promise<void> => {
    if (spinning || bets.length === 0 || staked > balance) return;
    setSpinning(true);
    setError(null);
    try {
      const result = await transport.play({ game: 'roulette', bet: staked, config: { bets } });
      const detail = result.detail as RouletteDetail;
      setLast(detail);
      setRecent((prev) => [detail.number, ...prev].slice(0, 12));
      onBalance(result.balance);
      setHistory((prev) => [
        {
          id: Date.now() + Math.random(),
          label: `${detail.number} ${detail.colour}`,
          won: result.payout > staked,
          net: result.payout - staked,
        },
        ...prev,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setSpinning(false);
    }
  };

  // The wheel: a canvas, because 37 rotating wedges as DOM would be absurd.
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
    context.clearRect(0, 0, size, size);

    /*
     * A real wheel, drawn ring by ring from the outside in.
     *
     * The first version was 37 pie slices from the centre with a green disc dropped on
     * top, which is a pie chart wearing a roulette wheel's colours: no rim, no ball
     * track, no frets between the pockets, no numbers, and a hollow middle. Every one of
     * those is load-bearing - the numbers most of all, because without them the wheel
     * carries no information at all and is purely decorative.
     *
     * Radii as fractions of the outer edge, which is the whole geometry of the thing:
     *   1.00-0.88  rim, the turned wooden edge
     *   0.88-0.79  ball track, where the ball runs before it drops
     *   0.79-0.50  pockets, with a fret between each
     *   0.50-0.15  cone, the polished slope down to the middle
     *   0.15-0     turret
     */
    const centre = size / 2;
    const outer = centre - 2;
    const step = (Math.PI * 2) / WHEEL_ORDER.length;
    // Turn the winning pocket to the top.
    const offset = last ? -last.pocketIndex * step - step / 2 - Math.PI / 2 : -Math.PI / 2;

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
    ring(0.79, 0.88, track);

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

    // The turret, and the winning number printed on it.
    const turret = context.createLinearGradient(
      centre - outer * 0.16, centre - outer * 0.16,
      centre + outer * 0.16, centre + outer * 0.16,
    );
    turret.addColorStop(0, '#f7e080');
    turret.addColorStop(0.5, '#a5842f');
    turret.addColorStop(1, '#e6c75a');
    ring(0, last ? 0.2 : 0.13, turret);

    context.beginPath();
    context.arc(centre, centre, outer * 0.5, 0, Math.PI * 2);
    context.strokeStyle = 'rgb(212 175 55 / 70%)';
    context.lineWidth = Math.max(1, size * 0.005);
    context.stroke();

    if (last) {
      context.fillStyle = '#1a1305';
      context.font = `750 ${Math.round(size * 0.1)}px "Inter Variable", system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(last.number), centre, centre);

      // The ball, resting on the track above the winning pocket.
      const ballAt = centre - outer * 0.835;
      const ball = context.createRadialGradient(
        centre - size * 0.008, ballAt - size * 0.008, size * 0.002,
        centre, ballAt, size * 0.026,
      );
      ball.addColorStop(0, '#ffffff');
      ball.addColorStop(0.6, '#d8d4c6');
      ball.addColorStop(1, '#8d8a7e');
      context.beginPath();
      context.arc(centre, ballAt, size * 0.026, 0, Math.PI * 2);
      context.fillStyle = ball;
      context.fill();
    }
  }, [last]);

  const winningNumbers = new Set(
    last?.bets.filter((b) => b.won).flatMap((b) => b.numbers) ?? [],
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
            <canvas ref={canvasRef} className="roulette__wheel" aria-hidden="true" />
            <div className="roulette__readout">
              <output className={`roulette__number is-${last ? last.colour : 'none'}`}>
                {last ? last.number : '—'}
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
                      className={`felt__number is-${colourOf(n)}${winningNumbers.has(n) ? ' is-winner' : ''}${last?.number === n ? ' is-drawn' : ''}`}
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

          {last && (
            <ul className="roulette__settled">
              {last.bets.map((b, i) => (
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
