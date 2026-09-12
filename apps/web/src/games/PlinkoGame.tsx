import {
  multipliersFor, ROW_CHOICES, type PlinkoDetail, type Risk, type Rows,
} from '@websino/engine';
import { useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier, formatMultiplierShort } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './PlinkoGame.css';

const RISKS: Risk[] = ['low', 'medium', 'high'];

/** How long the ball spends on each row. Slow enough to follow, fast enough to replay. */
const ROW_MS = 90;

export function PlinkoGame({
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
  const [rows, setRows] = useState<Rows>(16);
  const [risk, setRisk] = useState<Risk>('medium');
  const [dropping, setDropping] = useState(false);
  const [last, setLast] = useState<PlinkoDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * How far down the board the ball has fallen, in rows.
   *
   * The whole path arrives with the result, so this is playback of a decided outcome -
   * never a simulation racing the server to a different answer.
   */
  const [step, setStep] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Preview the table for the current settings, so the board is never blank.
  const multipliers = last?.multipliers ?? multipliersFor({ rows, risk });
  const shownRows = last?.rows ?? rows;

  const drop = async (): Promise<void> => {
    if (dropping || bet > balance) return;
    setDropping(true);
    setError(null);
    try {
      const result = await transport.play({ game: 'plinko', bet, config: { rows, risk } });
      const detail = result.detail as PlinkoDetail;
      setLast(detail);
      onBalance(result.balance);

      // Walk the ball down the path the server drew.
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setStep(0);
      for (let row = 1; row <= detail.rows; row += 1) {
        timers.current.push(setTimeout(() => setStep(row), row * ROW_MS));
      }
      timers.current.push(
        setTimeout(() => {
          setStep(null);
          setHistory((prev) => [
            {
              id: Date.now() + Math.random(),
              label: `bucket ${detail.bucket} · ${formatMultiplier(result.multiplier)}`,
              won: result.payout > bet,
              net: result.payout - bet,
            },
            ...prev,
          ]);
        }, (detail.rows + 1) * ROW_MS),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setDropping(false);
    }
  };

  /**
   * Where anything sits on the board, as a fraction across it.
   *
   * Pegs, the ball and the buckets all go through this one function, so they line up by
   * construction rather than by two sets of spacing rules happening to agree. A ball
   * that has fallen `step` rows bouncing right `rights` times is directly above bucket
   * `rights` once `step` reaches the bottom.
   */
  const positionOf = (step: number, rights: number): number =>
    (rights + (shownRows - step) / 2 + 0.5) / (shownRows + 1);

  const ballAt = (): { row: number; offset: number } | null => {
    if (last === null || step === null) return null;
    const rights = last.path.slice(0, step).filter(Boolean).length;
    return { row: step, offset: positionOf(step, rights) };
  };

  const ball = ballAt();
  const landed = step === null && last !== null;

  return (
    <GameShell
      title="Plinko"
      subtitle="Drop a ball, take the bucket · every board returns 99%"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={dropping}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="plinko">
          <div className="plinko__pegs">
            {Array.from({ length: shownRows }, (_, row) =>
              // Row `row` is the set of places a ball can be after `row + 1` bounces.
              Array.from({ length: row + 2 }, (_, peg) => (
                <span
                  className={`plinko__peg${ball && ball.row === row + 1 ? ' is-live' : ''}`}
                  key={`${row}-${peg}`}
                  style={{
                    insetInlineStart: `${positionOf(row + 1, peg) * 100}%`,
                    insetBlockStart: `${((row + 1) / (shownRows + 1)) * 100}%`,
                  }}
                />
              )),
            )}

            {ball && (
              <span
                className="plinko__ball"
                style={{
                  insetInlineStart: `${ball.offset * 100}%`,
                  insetBlockStart: `${(ball.row / (shownRows + 1)) * 100}%`,
                }}
              />
            )}
          </div>

          <ol className="plinko__buckets">
            {multipliers.map((multiplier, bucket) => (
              <li
                key={bucket}
                className={[
                  'bucket',
                  landed && last?.bucket === bucket ? 'is-hit' : '',
                  multiplier >= 1 ? 'is-paying' : 'is-losing',
                ].filter(Boolean).join(' ')}
                // Scale the tint with how far above 1x the bucket pays.
                style={{ '--heat': Math.min(1, Math.log10(multiplier + 1) / 2) } as React.CSSProperties}
              >
                <span className="numeric">{formatMultiplierShort(multiplier)}</span>
              </li>
            ))}
          </ol>
        </div>
      }
      controls={
        <div className="plinko__controls">
          <fieldset className="plinko__set">
            <legend>Rows</legend>
            <div className="plinko__choices">
              {ROW_CHOICES.map((choice) => (
                <button
                  key={choice}
                  className={`chip-btn${rows === choice ? ' is-active' : ''}`}
                  onClick={() => setRows(choice)}
                  disabled={dropping}
                >
                  {choice}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="plinko__set">
            <legend>Risk</legend>
            <div className="plinko__choices">
              {RISKS.map((choice) => (
                <button
                  key={choice}
                  className={`chip-btn${risk === choice ? ' is-active' : ''}`}
                  onClick={() => setRisk(choice)}
                  disabled={dropping}
                >
                  {choice}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            className="btn btn--primary plinko__drop"
            onClick={() => void drop()}
            disabled={dropping || bet > balance || bet < 1}
          >
            {dropping ? 'Dropping…' : `Drop for ${formatChips(bet)}`}
          </button>

          {error && <p className="plinko__error">{error}</p>}

          <dl className="plinko__stats">
            <div>
              <dt>Best bucket</dt>
              <dd className="numeric">{formatMultiplier(Math.max(...multipliers))}</dd>
            </div>
            <div>
              <dt>Centre</dt>
              <dd className="numeric">
                {formatMultiplier(multipliers[Math.floor(multipliers.length / 2)] ?? 0)}
              </dd>
            </div>
          </dl>

          <p className="plinko__note">
            The middle is where the ball almost always lands — the edges are a run of
            {' '}{shownRows} bounces the same way, about 1 in {(2 ** shownRows).toLocaleString()}.
          </p>
        </div>
      }
    />
  );
}
