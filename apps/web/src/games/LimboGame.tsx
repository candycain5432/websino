import type { LimboDetail } from '@websino/engine';
import { useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './LimboGame.css';

export function LimboGame({
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
  const [target, setTarget] = useState(200);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LimboDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const targetX = target / 100;
  // P(result >= x) = (1 - edge) / x - the reason every target is worth the same.
  const chance = 0.99 / targetX;

  const play = async (): Promise<void> => {
    if (busy || bet > balance) return;
    setBusy(true);
    setError(null);
    try {
      const result = await transport.play({ game: 'limbo', bet, config: { target } });
      const detail = result.detail as LimboDetail;
      setLast(detail);
      onBalance(result.balance);
      setHistory((prev) => [
        {
          id: Date.now() + Math.random(),
          label: formatMultiplier(detail.result / 100),
          won: detail.won,
          net: result.payout - bet,
        },
        ...prev,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <GameShell
      title="Limbo"
      subtitle="Pick a target · win if the draw reaches it · house edge 1%"
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={busy}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="limbo">
          <output
            key={last ? `${last.result}-${history.length}` : 'idle'}
            className={`limbo__result${last ? (last.won ? ' is-win' : ' is-loss') : ''}`}
          >
            <span className="numeric">
              {last ? formatMultiplier(last.result / 100) : '—.——×'}
            </span>
          </output>
          <p className="limbo__caption">
            {last
              ? last.won
                ? `Cleared ${formatMultiplier(targetX)}`
                : `Fell short of ${formatMultiplier(targetX)}`
              : `Needs ${formatMultiplier(targetX)} or better`}
          </p>
        </div>
      }
      controls={
        <div className="limbo__controls">
          <label className="limbo__label" htmlFor="limbo-target">
            <span>Target multiplier</span>
            <strong className="numeric">{formatMultiplier(targetX)}</strong>
          </label>
          <input
            id="limbo-target"
            className="limbo__input numeric"
            type="number"
            min={1.01}
            max={1000}
            step={0.01}
            value={targetX}
            disabled={busy}
            onChange={(event) =>
              setTarget(Math.max(101, Math.round(Number(event.target.value) * 100) || 101))
            }
          />

          <div className="limbo__presets">
            {[150, 200, 300, 1000].map((preset) => (
              <button
                key={preset}
                className={`btn btn--ghost limbo__preset${target === preset ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setTarget(preset)}
              >
                {formatMultiplier(preset / 100)}
              </button>
            ))}
          </div>

          <dl className="limbo__stats">
            <div>
              <dt>Win chance</dt>
              <dd className="numeric">{(chance * 100).toFixed(2)}%</dd>
            </div>
            <div>
              <dt>To win</dt>
              <dd className="numeric">{formatChips(Math.floor(bet * targetX))}</dd>
            </div>
          </dl>

          {error && <p className="limbo__error">{error}</p>}

          <button
            className="btn btn--primary limbo__play"
            onClick={() => void play()}
            disabled={busy || bet > balance}
          >
            {busy ? 'Drawing…' : 'Play'}
          </button>
        </div>
      }
    />
  );
}
