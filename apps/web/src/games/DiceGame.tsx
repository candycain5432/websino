import { multiplierFor, winChanceOf, type DiceDetail, type DiceDirection } from '@websino/engine';
import { useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatHundredths, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './DiceGame.css';

export function DiceGame({
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
  const [target, setTarget] = useState(5000);
  const [direction, setDirection] = useState<DiceDirection>('over');
  const [rolling, setRolling] = useState(false);
  const [last, setLast] = useState<DiceDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const config = { target, direction };
  const chance = winChanceOf(config);
  const payout = multiplierFor(config);
  const legal = chance >= 0.01 && chance <= 0.95;

  const roll = async (): Promise<void> => {
    if (rolling || bet > balance || !legal) return;
    setRolling(true);
    setError(null);
    try {
      const result = await transport.play({ game: 'dice', bet, config });
      const detail = result.detail as DiceDetail;
      setLast(detail);
      onBalance(result.balance);
      setHistory((prev) => [
        {
          id: Date.now() + Math.random(),
          label: `${formatHundredths(detail.roll)} ${detail.direction} ${formatHundredths(detail.target)}`,
          won: detail.won,
          net: result.payout - bet,
        },
        ...prev,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setRolling(false);
    }
  };

  // The slider is the win-chance threshold; the marker is the last roll.
  const thresholdPercent = target / 100;
  const rollPercent = last ? last.roll / 100 : null;

  return (
    <GameShell
      title="Dice"
      subtitle={`Roll 0.00–99.99 · house edge 1% · every target pays the same expected value`}
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={rolling}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="dice">
          <output className={`dice__roll${last ? (last.won ? ' is-win' : ' is-loss') : ''}`}>
            <span className="numeric">{last ? formatHundredths(last.roll) : '--.--'}</span>
          </output>

          <div className="dice__track" role="presentation">
            <div
              className={`dice__zone dice__zone--${direction}`}
              style={{
                left: direction === 'over' ? `${thresholdPercent}%` : 0,
                width: direction === 'over' ? `${100 - thresholdPercent}%` : `${thresholdPercent}%`,
              }}
            />
            <div className="dice__threshold" style={{ left: `${thresholdPercent}%` }}>
              <span className="dice__threshold-label numeric">{formatHundredths(target)}</span>
            </div>
            {rollPercent !== null && (
              <div
                className={`dice__marker${last?.won ? ' is-win' : ' is-loss'}`}
                style={{ left: `${rollPercent}%` }}
              />
            )}
          </div>

          <div className="dice__scale" aria-hidden="true">
            <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
          </div>
        </div>
      }
      controls={
        <div className="dice__controls">
          <div className="dice__direction" role="group" aria-label="Roll direction">
            {(['under', 'over'] as const).map((option) => (
              <button
                key={option}
                className={`dice__dir-btn${direction === option ? ' is-active' : ''}`}
                onClick={() => setDirection(option)}
                disabled={rolling}
              >
                Roll {option}
              </button>
            ))}
          </div>

          <label className="dice__slider-label">
            <span>Target</span>
            <strong className="numeric">{formatHundredths(target)}</strong>
          </label>
          <input
            className="dice__slider"
            type="range"
            min={200}
            max={9800}
            step={1}
            value={target}
            disabled={rolling}
            onChange={(event) => setTarget(Number(event.target.value))}
          />

          <dl className="dice__stats">
            <div>
              <dt>Win chance</dt>
              <dd className="numeric">{(chance * 100).toFixed(2)}%</dd>
            </div>
            <div>
              <dt>Payout</dt>
              <dd className="numeric">{legal ? formatMultiplier(payout) : '—'}</dd>
            </div>
            <div>
              <dt>To win</dt>
              <dd className="numeric">{legal ? formatChips(Math.floor(bet * payout)) : '—'}</dd>
            </div>
          </dl>

          {error && <p className="dice__error">{error}</p>}

          <button
            className="btn btn--primary dice__roll-btn"
            onClick={() => void roll()}
            disabled={rolling || bet > balance || !legal}
          >
            {rolling ? 'Rolling…' : 'Roll'}
          </button>
        </div>
      }
    />
  );
}
