import {
  exactReturn, lineCountOf, machineById, MACHINES, REELS, ROWS, SCATTER, WILD,
  type SlotMachine, type SlotsDetail, type Spin,
} from '@websino/engine';
import { useEffect, useMemo, useRef, useState } from 'react';

import { GameShell, type HistoryEntry } from '../components/GameShell.js';
import { formatChips, formatMultiplier } from '../lib/format.js';
import type { GameTransport } from '../lib/transport.js';
import './SlotsGame.css';

/**
 * How long each spin of a bonus stays on screen before the next one.
 *
 * Just under the time the fifth reel takes to settle, so a bonus reads as one continuous
 * run of the machine rather than as a series of separate spins with a pause between them.
 */
const BONUS_SPIN_MS = 1_900;

/**
 * How many symbols tear past the window before a reel lands.
 *
 * The number is the entire feel of the spin: too few and the reel slides rather than
 * spins, too many and the fast part is a grey smear that lasts long enough to be a wait.
 * Twenty at this duration puts the last four or five symbols slow enough to read as they
 * go by, which is what makes a near-miss land.
 */
const SPIN_CELLS = 20;

/** The first reel's travel time, and what each reel to its right adds to it. */
const SPIN_MS = 1_150;
const REEL_STAGGER_MS = 190;

/** A still screen for a cabinet nobody has spun yet - its own symbols, not another's. */
const blankGrid = (machine: SlotMachine): string[][] =>
  Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: REELS }, (_, col) =>
      machine.symbols[(row * REELS + col) % machine.symbols.length] as string),
  );

/**
 * The symbols that blur past on the way down.
 *
 * Decoration, so it is drawn from `Math.random` rather than from the round's fair stream -
 * the same rule that keeps bots and hints off it. Nothing here is ever paid on: the only
 * symbols that mean anything are the three the server sent, which sit at the end of the
 * strip where the reel comes to rest.
 */
const filler = (machine: SlotMachine, length: number): string[] =>
  Array.from({ length }, () =>
    machine.symbols[Math.floor(Math.random() * machine.symbols.length)] as string);

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
  const [waiting, setWaiting] = useState(false);
  const [detail, setDetail] = useState<SlotsDetail | null>(null);
  const [shown, setShown] = useState(0);
  /**
   * Bumped once per landing - the opening spin and every bonus spin after it.
   *
   * The reels watch this rather than the grid itself, because two spins in a row can
   * legitimately land the same symbols and the second one still has to spin. A value that
   * changes on every landing says "go again" without the reels having to diff anything.
   */
  const [spinKey, setSpinKey] = useState(0);
  /**
   * Whether the reels showing `shown` have stopped.
   *
   * Separate from `spinning`, which stays true for the whole of a ten-spin bonus: this
   * goes false and true again on every individual spin. Anything that reads the result -
   * the payout figure, the winning lines - waits on this, because a machine that prints
   * what it paid while its reels are still turning has answered the question the reels
   * were about to answer.
   */
  const [landed, setLanded] = useState(true);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);

  /*
   * One place that knows when the reels have stopped.
   *
   * Keyed on `spinKey`, which is bumped by the opening spin *and* by every bonus spin, so
   * this covers both without either of them having to remember to. The extra 60ms is
   * slack for the overshoot at the end of the reel's easing curve, which finishes a frame
   * or two after the nominal duration.
   */
  useEffect(() => {
    if (spinKey === 0) return;
    setLanded(false);
    const settle = SPIN_MS + REEL_STAGGER_MS * (REELS - 1) + 60;
    const id = window.setTimeout(() => setLanded(true), settle);
    return () => window.clearTimeout(id);
  }, [spinKey]);

  const spin = async (): Promise<void> => {
    if (spinning || bet > balance || bet < lineCount) return;
    setSpinning(true);
    setWaiting(true);
    setLanded(false);
    setError(null);
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];

    try {
      const result = await transport.play({ game: 'slots', bet, config: { machine: cabinet } });
      const next = result.detail as SlotsDetail;
      setDetail(next);
      setShown(0);
      setSpinKey((key) => key + 1);
      setWaiting(false);
      onBalance(result.balance);

      // Walk the bonus one spin at a time so a ten-spin round is watchable rather
      // than a single number appearing from nowhere.
      for (let i = 1; i < next.spins.length; i += 1) {
        timers.current.push(
          window.setTimeout(() => {
            setShown(i);
            setSpinKey((key) => key + 1);
          }, BONUS_SPIN_MS * i),
        );
      }

      /*
       * Everything that announces the result waits for the fifth reel.
       *
       * The last reel is still travelling when the strip stops being told to move, and the
       * history entry is what the shell fires its win celebration from - so posting it
       * when the result arrived threw confetti over a machine that was still spinning,
       * which gives the answer away three seconds early and makes the reels pointless.
       */
      const settle = SPIN_MS + REEL_STAGGER_MS * (REELS - 1);
      timers.current.push(
        window.setTimeout(
          () => {
            setSpinning(false);
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
          },
          BONUS_SPIN_MS * (next.spins.length - 1) + settle,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
      setSpinning(false);
      setWaiting(false);
      setLanded(true);
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
  const won = landed && current !== undefined && current.units > 0;

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
          <div
            className={[
              'slots__machine',
              current?.isFreeSpin ? 'is-bonus' : '',
              won ? 'is-win' : '',
            ].filter(Boolean).join(' ')}
          >
            {/* The marquee across the top of the case, lit while the reels are live. */}
            <div className={`slots__lamps${spinning ? ' is-live' : ''}`} aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="slots__lamp" style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </div>

            <div
              className={`slots__grid${waiting ? ' is-waiting' : ''}`}
              role="img"
              aria-label={describeGrid(machine, grid)}
            >
              {Array.from({ length: REELS }, (_, column) => (
                <Reel
                  key={column}
                  machine={machine}
                  column={column}
                  spinKey={spinKey}
                  symbols={grid.map((row) => row[column] ?? '')}
                  lit={grid.map((_, row) => lit.has(`${row}:${column}`))}
                />
              ))}

              {/* The payline the eye follows, dimmed until something lands on it. */}
              <span className="slots__payline" aria-hidden="true" />
            </div>

            {current?.isFreeSpin && (
              <div className="slots__bonus-badge">
                Free spin · {machine.freeSpinMultiplier}×
                {freeSpinsLeft > 0 && <span> · {freeSpinsLeft} to go</span>}
              </div>
            )}
          </div>

          <output
            key={won ? `win-${spinKey}` : 'idle'}
            className={`slots__win${won ? ' is-win' : ''}`}
          >
            {!landed
              ? ' '
              : current && current.units > 0
                ? `+${formatChips(Math.floor(current.units * lineBet))}`
                : detail
                  ? 'No win'
                  : 'Spin to play'}
          </output>

          {won && current.lineWins.length > 0 && (
            <ul className="slots__lines">
              {current.lineWins.slice(0, 6).map((win, i) => (
                <li key={win.lineIndex} style={{ animationDelay: `${i * 70}ms` }}>
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

/**
 * One reel: a strip of symbols behind a three-symbol window.
 *
 * The reel that was here before was three cells that changed their text and flashed, which
 * is a slideshow rather than a machine - the whole appeal of a slot is watching the thing
 * you want go past and not stop. So the strip is real: twenty throwaway symbols, then the
 * three the server sent, then one more so the bounce at the end has something to land on.
 *
 * The spin is two frames of bookkeeping. On a new `spinKey` the strip jumps to the top of
 * its filler with transitions off - a jump nobody sees, because it happens before the
 * browser paints - and on the next frame the transition is switched back on and the strip
 * travels down to rest on the result. Deceleration is the easing curve, and the curve
 * overshoots slightly, so the reel settles the way a real one drops back onto its detent.
 *
 * Which means the landing position is not a choice: the reel *cannot* stop anywhere except
 * on the three symbols the round already decided. There is no animation here that could
 * disagree with the result.
 */
function Reel({
  machine,
  column,
  spinKey,
  symbols,
  lit,
}: {
  machine: SlotMachine;
  column: number;
  spinKey: number;
  symbols: readonly string[];
  lit: readonly boolean[];
}) {
  // Re-drawn per landing, so two spins never blur past the same throwaway symbols.
  const padding = useMemo(
    () => ({ lead: filler(machine, SPIN_CELLS), tail: filler(machine, 1) }),
    [machine, spinKey],
  );

  /** `top` is the pre-spin frame with transitions off; `rest` is the travel down. */
  const [phase, setPhase] = useState<'top' | 'rest'>('rest');
  /** False from the moment this reel is launched until it has stopped moving. */
  const [settled, setSettled] = useState(true);

  const travel = SPIN_MS + column * REEL_STAGGER_MS;

  useEffect(() => {
    if (spinKey === 0) return;
    setPhase('top');
    setSettled(false);
    /*
     * Two frames, not one.
     *
     * A single frame is not enough: React can flush the `top` render and the `rest`
     * render into the same paint, and a transition between two styles the browser never
     * separately painted does not run at all - the reel would teleport. Waiting for the
     * frame *after* the one that painted the jump is what makes the travel real.
     */
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase('rest'));
    });
    const landed = window.setTimeout(() => setSettled(true), travel + 60);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(landed);
    };
  }, [spinKey, travel]);

  return (
    <span className="reel">
      <span
        className={`reel__strip${phase === 'top' ? ' is-launched' : ''}`}
        style={{
          transform: phase === 'top'
            ? 'translateY(0)'
            : `translateY(calc(var(--cell) * -${SPIN_CELLS}))`,
          // Zero in the `top` frame, which is what keeps that jump from animating.
          '--spin-ms': `${phase === 'top' ? 0 : travel}ms`,
        } as React.CSSProperties}
      >
        {padding.lead.map((symbol, i) => (
          <Cell key={`lead-${i}`} machine={machine} symbol={symbol} />
        ))}
        {symbols.map((symbol, row) => (
          <Cell
            key={`row-${row}`}
            machine={machine}
            symbol={symbol}
            // Held back until this reel has stopped: a cell cannot announce itself as
            // part of a win while it is still going past.
            lit={lit[row] === true && settled}
            delay={row * 90 + column * 60}
          />
        ))}
        <Cell key="tail" machine={machine} symbol={padding.tail[0] ?? ''} />
      </span>
    </span>
  );
}

function Cell({
  machine,
  symbol,
  lit = false,
  delay = 0,
}: {
  machine: SlotMachine;
  symbol: string;
  lit?: boolean;
  delay?: number;
}) {
  return (
    <span
      className={`slots__cell slots__cell--${symbol}${lit ? ' is-lit' : ''}`}
      style={lit ? { animationDelay: `${delay}ms` } : undefined}
    >
      {machine.glyphs[symbol] ?? symbol}
    </span>
  );
}

function describeGrid(machine: SlotMachine, grid: readonly (readonly string[])[]): string {
  return grid.map((row) => row.map((s) => machine.names[s] ?? s).join(', ')).join('; ');
}
