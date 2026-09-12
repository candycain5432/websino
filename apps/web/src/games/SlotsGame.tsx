import {
  exactReturn, lineCountOf, machineById, MACHINES, REELS, ROWS, SCATTER, WILD,
  type SlotMachine, type SlotsDetail, type Spin,
} from '@websino/engine';
import { useEffect, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './SlotsGame.css';

/** How long each spin of a bonus stays on screen before the next one. */
const BONUS_SPIN_MS = 850;

/** A still screen for a cabinet nobody has spun yet - its own symbols, not another's. */
const blankGrid = (machine: SlotMachine): string[][] =>
  Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: REELS }, (_, col) =>
      machine.symbols[(row * REELS + col) % machine.symbols.length] as string),
  );

export function SlotsGame({
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
  const [bet, setBet] = useState(20);
  const [cabinet, setCabinet] = useState(MACHINES[0]?.id ?? 'golden');
  const [spinning, setSpinning] = useState(false);
  const [detail, setDetail] = useState<SlotsDetail | null>(null);
  const [shown, setShown] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);

  const spin = async (): Promise<void> => {
    if (spinning || bet > balance || bet < lineCount) return;
    setSpinning(true);
    setError(null);
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];

    try {
      const result = await transport.play({ game: 'slots', bet, config: { machine: cabinet } });
      const next = result.detail as SlotsDetail;
      setDetail(next);
      setShown(0);
      onBalance(result.balance);
      setHistory((prev) => [
        {
          id: Date.now() + Math.random(),
          label: next.freeSpinsPlayed
            ? `${next.freeSpinsPlayed} free spins`
            : result.payout > 0
              ? formatMultiplier(result.payout / bet)
              : 'No win',
          won: result.payout > bet,
          net: result.payout - bet,
        },
        ...prev,
      ]);

      // Walk the bonus one spin at a time so a ten-spin round is watchable rather
      // than a single number appearing from nowhere.
      for (let i = 1; i < next.spins.length; i += 1) {
        timers.current.push(
          window.setTimeout(() => setShown(i), BONUS_SPIN_MS * i),
        );
      }
      timers.current.push(
        window.setTimeout(() => setSpinning(false), BONUS_SPIN_MS * (next.spins.length - 1)),
      );
      if (next.spins.length <= 1) setSpinning(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
      setSpinning(false);
    }
  };

  /*
   * The cabinet the *round* used, not the one the picker shows.
   *
   * They differ for exactly as long as a result is on screen after the player has
   * switched cabinets, and rendering last round's grid with this cabinet's glyphs would
   * show symbols that were never on those reels.
   */
  const machine = machineById(detail?.machine ?? cabinet);
  const lineCount = lineCountOf(machine);
  const lineBet = bet / lineCount;

  const spins: Spin[] = detail?.spins ?? [];
  const current: Spin | undefined = spins[shown];
  const grid = current?.grid ?? blankGrid(machine);

  // Cells that are part of a win on the spin currently on screen.
  const lit = new Set<string>();
  if (current) {
    for (const win of current.lineWins) {
      for (const [column, row] of win.positions) lit.add(`${row}:${column}`);
    }
    if (current.scatterCount >= 3) {
      for (let row = 0; row < ROWS; row += 1) {
        for (let column = 0; column < REELS; column += 1) {
          if (current.grid[row]?.[column] === SCATTER) lit.add(`${row}:${column}`);
        }
      }
    }
  }

  const freeSpinsLeft = detail ? Math.max(0, detail.spins.length - 1 - shown) : 0;

  return (
    <GameShell
      title={machine.name}
      subtitle={
        `5 reels · ${lineCount} lines · RTP ${(exactReturn(machine).rtp * 100).toFixed(2)}%`
        + ` · free spins pay ${machine.freeSpinMultiplier}×`
      }
      transport={transport}
      balance={balance}
      bet={bet}
      onBetChange={setBet}
      disabled={spinning}
      onBack={onBack}
      history={history}
      onTopUp={transport.topUp ? () => void transport.topUp?.().then(onBalance) : undefined}
      board={
        <div className="slots">
          <div className={`slots__machine${current?.isFreeSpin ? ' is-bonus' : ''}`}>
            <div className="slots__grid" role="img" aria-label={describeGrid(machine, grid)}>
              {grid.map((row, r) =>
                row.map((symbol, c) => (
                  <span
                    key={`${r}:${c}`}
                    className={[
                      'slots__cell',
                      `slots__cell--${symbol}`,
                      lit.has(`${r}:${c}`) ? 'is-lit' : '',
                      spinning && shown === 0 ? 'is-spinning' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ animationDelay: `${c * 60}ms` }}
                  >
                    {machine.glyphs[symbol] ?? symbol}
                  </span>
                )),
              )}
            </div>

            {current?.isFreeSpin && (
              <div className="slots__bonus-badge">
                Free spin · {machine.freeSpinMultiplier}×
                {freeSpinsLeft > 0 && <span> · {freeSpinsLeft} to go</span>}
              </div>
            )}
          </div>

          <output className={`slots__win${current && current.units > 0 ? ' is-win' : ''}`}>
            {current && current.units > 0
              ? `+${formatChips(Math.floor(current.units * lineBet))}`
              : detail
                ? 'No win'
                : 'Spin to play'}
          </output>

          {current && current.lineWins.length > 0 && (
            <ul className="slots__lines">
              {current.lineWins.slice(0, 6).map((win) => (
                <li key={win.lineIndex}>
                  <span className="slots__line-symbol">
                    {machine.glyphs[win.symbol]}
                  </span>
                  <span>
                    {win.count}× {machine.names[win.symbol]} on line{' '}
                    {win.lineIndex + 1}
                  </span>
                  <span className="numeric">
                    +{formatChips(Math.floor(win.units * lineBet * current.multiplier))}
                  </span>
                </li>
              ))}
              {current.lineWins.length > 6 && (
                <li className="slots__lines-more">
                  and {current.lineWins.length - 6} more
                </li>
              )}
            </ul>
          )}
        </div>
      }
      controls={
        <div className="slots__controls">
          <fieldset className="slots__set">
            <legend>Cabinet</legend>
            <div className="slots__cabinets">
              {MACHINES.map((option) => (
                <button
                  key={option.id}
                  className={`cabinet${cabinet === option.id ? ' is-active' : ''}`}
                  style={{ '--cabinet-accent': option.accent } as React.CSSProperties}
                  onClick={() => setCabinet(option.id)}
                  disabled={spinning}
                >
                  <span className="cabinet__name">{option.name}</span>
                  <span className="cabinet__blurb">{option.blurb}</span>
                  {/* Quoted per cabinet because they genuinely differ, if only slightly. */}
                  <span className="cabinet__rtp numeric">
                    RTP {(exactReturn(option).rtp * 100).toFixed(2)}%
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <p className="slots__stake">
            <span>Line bet</span>
            <strong className="numeric">{(lineBet).toFixed(2)}</strong>
          </p>

          {bet < lineCount && (
            <p className="slots__warn">
              All {lineCount} lines are always in play, so the stake is split between them.
              Bet at least {lineCount} to keep every line worth a whole chip.
            </p>
          )}

          {error && <p className="slots__error">{error}</p>}

          <button
            className="btn btn--primary slots__spin"
            onClick={() => void spin()}
            disabled={spinning || bet > balance || bet < 1}
          >
            {spinning ? 'Spinning…' : 'Spin'}
          </button>

          <details className="slots__paytable">
            <summary>Paytable</summary>
            <table>
              <thead>
                <tr><th>Symbol</th><th>3</th><th>4</th><th>5</th></tr>
              </thead>
              <tbody>
                {machine.symbols.filter((s) => s !== SCATTER).map((symbol) => (
                  <tr key={symbol} className={symbol === WILD ? 'is-wild' : ''}>
                    <th scope="row">
                      <span className="slots__line-symbol">{machine.glyphs[symbol]}</span>
                      {machine.names[symbol]}
                    </th>
                    {(machine.paytable[symbol] ?? []).map((pay, i) => (
                      <td key={i} className="numeric">{pay}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Pays are multiples of the line bet, left to right from reel one. Wilds
              substitute for everything except scatters. Three scatters anywhere pay{' '}
              {machine.scatterPays[3]}× the total bet and buy {machine.freeSpinAward[3]} free
              spins at {machine.freeSpinMultiplier}×.
            </p>
          </details>
        </div>
      }
    />
  );
}

function describeGrid(machine: SlotMachine, grid: readonly (readonly string[])[]): string {
  return grid.map((row) => row.map((s) => machine.names[s] ?? s).join(', ')).join('; ');
}
