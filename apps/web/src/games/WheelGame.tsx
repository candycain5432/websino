import {
  wheelFor, SEGMENT_CHOICES, type Segments, type WheelDetail, type WheelRisk,
} from '@websino/engine';
import { useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './WheelGame.css';

const RISKS: WheelRisk[] = ['low', 'medium', 'high'];

/** How long the wheel spins before settling, and how many turns it takes getting there. */
const SPIN_MS = 2_600;
const SPIN_TURNS = 5;

export function WheelGame({
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
  const [segments, setSegments] = useState<Segments>(30);
  const [risk, setRisk] = useState<WheelRisk>('medium');
  const [spinning, setSpinning] = useState(false);
  const [last, setLast] = useState<WheelDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Where the wheel is pointing, in degrees. Only ever increases, so the wheel always
   * turns forwards - snapping back to a smaller angle looks like a rewind.
   */
  const [angle, setAngle] = useState(0);
  /** The hub stays blank until the wheel stops, so the spin is not spoiled early. */
  const [revealed, setRevealed] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const board = last && !revealed ? last.wheel : wheelFor({ segments, risk });
  const shownSegments = last && !revealed ? last.segments : segments;

  const spin = async (): Promise<void> => {
    if (spinning || bet > balance) return;
    setSpinning(true);
    setRevealed(false);
    setError(null);
    try {
      const result = await transport.play({ game: 'wheel', bet, config: { segments, risk } });
      const detail = result.detail as WheelDetail;
      setLast(detail);

      // Applied now, not when the wheel stops. Holding it back hid the result for a
      // moment longer and meant that leaving the screen mid-spin - which cancels the
      // timer - left a stale balance in the header. A number that is briefly a spoiler
      // beats a number that is briefly wrong.
      onBalance(result.balance);

      // Spin to the segment the server already picked. The rotation is presentation
      // over a decided outcome, so it can only ever land where the result says.
      const per = 360 / detail.segments;
      const target = 360 - (detail.index * per + per / 2);
      setAngle((current) => current + SPIN_TURNS * 360 + ((target - (current % 360)) + 360) % 360);

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setRevealed(true);
        setSpinning(false);
        setHistory((prev) => [
          {
            id: Date.now() + Math.random(),
            label: detail.won ? `${formatMultiplier(result.multiplier)} segment` : 'blank',
            won: result.payout > bet,
            net: result.payout - bet,
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

  const per = 360 / shownSegments;
  const best = Math.max(...board);
  const paying = board.filter((value) => value > 0).length;

  return (
    <GameShell
      title="Wheel of Fortune"
      subtitle="One spin, one segment · every wheel returns 99%"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={spinning}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="wof">
          <div className="wof__pointer" aria-hidden="true" />

          {/*
            * The hub sits outside the rotating element, not inside it.
            *
            * Nesting it meant the reading turned with the wheel and came to rest upside
            * down about half the time. Counter-rotating it would work and would also
            * mean keeping two transforms in step forever; not rotating it at all is
            * simply correct.
            */}
          <div className="wof__hub">
            {revealed && last ? (
              <>
                <span className={`wof__result numeric${last.won ? ' is-win' : ''}`}>
                  {last.won ? formatMultiplier(last.wheel[last.index] ?? 0) : '—'}
                </span>
                <span className="wof__caption">{last.won ? 'paid' : 'blank'}</span>
              </>
            ) : (
              <span className="wof__caption">{spinning ? 'spinning…' : 'spin'}</span>
            )}
          </div>

          <div
            className="wof__wheel"
            data-index={last && revealed ? last.index : ''}
            data-angle={angle}
            style={{
              transform: `rotate(${angle}deg)`,
              transitionDuration: `${SPIN_MS}ms`,
              // A conic gradient paints every segment in one declaration; drawing them
              // as elements would be N nodes re-created on every settings change.
              background: `conic-gradient(${board
                .map((value, i) => {
                  const colour = value === 0
                    ? 'var(--felt-dark)'
                    : value >= best
                      ? 'var(--gold)'
                      : `color-mix(in srgb, var(--win) ${Math.min(90, value * 30)}%, var(--felt))`;
                  return `${colour} ${i * per}deg ${(i + 1) * per}deg`;
                })
                .join(', ')})`,
            }}
          />
        </div>
      }
      controls={
        <div className="wof__controls">
          <fieldset className="wof__set">
            <legend>Segments</legend>
            <div className="wof__choices">
              {SEGMENT_CHOICES.map((choice) => (
                <button
                  key={choice}
                  className={`chip-btn${segments === choice ? ' is-active' : ''}`}
                  onClick={() => setSegments(choice)}
                  disabled={spinning}
                >
                  {choice}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="wof__set">
            <legend>Risk</legend>
            <div className="wof__choices">
              {RISKS.map((choice) => (
                <button
                  key={choice}
                  className={`chip-btn${risk === choice ? ' is-active' : ''}`}
                  onClick={() => setRisk(choice)}
                  disabled={spinning}
                >
                  {choice}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            className="btn btn--primary wof__spin"
            onClick={() => void spin()}
            disabled={spinning || bet > balance || bet < 1}
          >
            {spinning ? 'Spinning…' : `Spin for ${formatChips(bet)}`}
          </button>

          {error && <p className="wof__error">{error}</p>}

          <dl className="wof__stats">
            <div>
              <dt>Top segment</dt>
              <dd className="numeric">{formatMultiplier(best)}</dd>
            </div>
            <div>
              <dt>Pays on</dt>
              <dd className="numeric">{paying} of {shownSegments}</dd>
            </div>
          </dl>

          <p className="wof__note">
            One spin caps what a segment can pay: every segment is equally likely, so
            they have to average 99% — a {shownSegments}-segment wheel cannot offer more
            than {formatMultiplier(shownSegments * 0.99)} however the prizes are arranged.
            A bigger headline needs more segments, not a different table.
          </p>
        </div>
      }
    />
  );
}
