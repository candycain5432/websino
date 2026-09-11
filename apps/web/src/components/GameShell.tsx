import type { ReactNode } from 'react';

import { formatChips } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import { BetControls } from './BetControls.js';
import { FairnessDrawer } from './FairnessDrawer.js';
import './GameShell.css';

export interface HistoryEntry {
  id: number;
  label: string;
  won: boolean;
  net: number;
}

/**
 * The frame every game sits inside: balance, stake controls, result banner, recent
 * history and the fairness drawer.
 *
 * Built once on purpose. In pysino each scene re-implemented its own bet controls and
 * stat panel, which is why the roulette scene ran to 516 lines. Here a new game is its
 * own board plus a config panel, and inherits everything else.
 */
export function GameShell({
  title,
  subtitle,
  transport,
  balance,
  bet,
  onBetChange,
  disabled,
  onBack,
  history,
  board,
  controls,
  onTopUp,
}: {
  title: string;
  subtitle: string;
  transport: GameTransport;
  balance: number;
  bet: number;
  onBetChange: (bet: number) => void;
  disabled: boolean;
  onBack: () => void;
  history: HistoryEntry[];
  board: ReactNode;
  controls: ReactNode;
  onTopUp?: (() => void) | undefined;
}) {
  const broke = balance < 1;

  return (
    <div className="shell">
      <header className="shell__bar">
        <button className="shell__back" onClick={onBack} aria-label="Back to the lobby">
          ← Lobby
        </button>

        <div className="shell__titles">
          <h1 className="shell__title">{title}</h1>
          <p className="shell__subtitle">{subtitle}</p>
        </div>

        <div className="shell__balance">
          {transport.mode === 'practice' && (
            <span className="shell__practice" title="Practice chips never reach your account">
              Practice
            </span>
          )}
          <span className="shell__chips numeric">{formatChips(balance)}</span>
        </div>
      </header>

      <main className="shell__main">
        <section className="shell__board">{board}</section>

        <aside className="shell__panel">
          <BetControls
            bet={bet}
            balance={balance}
            disabled={disabled}
            onChange={onBetChange}
          />
          {controls}

          {broke && onTopUp && (
            <button className="btn btn--ghost shell__topup" onClick={onTopUp}>
              Out of practice chips — top up
            </button>
          )}

          {history.length > 0 && (
            <div className="shell__history">
              <h2 className="shell__history-title">Recent</h2>
              <ul className="shell__history-list">
                {history.slice(0, 8).map((entry) => (
                  <li
                    key={entry.id}
                    className={`shell__history-item ${entry.won ? 'is-win' : 'is-loss'}`}
                  >
                    <span>{entry.label}</span>
                    <span className="numeric">
                      {entry.net > 0 ? '+' : ''}
                      {formatChips(entry.net)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <FairnessDrawer transport={transport} roundCount={history.length} />
        </aside>
      </main>
    </div>
  );
}
