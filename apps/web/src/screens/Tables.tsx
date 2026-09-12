/**
 * Shared tables: the floor, and a live seat at one of them.
 *
 * This screen does not use `GameShell`. The shell is built around a single player's
 * stake-and-spin loop - one bet box, one result banner, a history of your own rounds -
 * and a shared table has none of that shape. Here the clock runs whether or not you are
 * looking, the interesting state belongs to six seats rather than one, and the thing you
 * choose before sitting is a buy-in, not a bet. Forcing it into the shell would have
 * meant a bet control that lies about what it does.
 *
 * Everything rendered here comes from the server's snapshot. The only local state is the
 * raise slider, which is a draft of an intent rather than a belief about the game.
 */

import type { RoomSummary, RoomView } from '@websino/engine';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PlayingCard } from '../components/PlayingCard.js';
import { formatChips } from '../lib/format.js';
import { fetchTables, TableSocket, type TableStatus } from '../lib/tableSocket.js';
import type { HoldemAction } from '../lib/transport.js';
import './Tables.css';

const STREET_LABELS: Record<string, string> = {
  preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', complete: 'Hand over',
};

const ACTION_LABELS: Record<HoldemAction, string> = {
  fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise',
};

const STATUS_LABELS: Record<TableStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting — your seat is held',
  closed: 'Disconnected',
};

export function Tables({
  balance,
  onBalance,
  onBack,
}: {
  balance: number;
  onBalance: (balance: number) => void;
  onBack: () => void;
}) {
  const [tables, setTables] = useState<RoomSummary[] | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchTables()
      .then((rows) => { setTables(rows); setListError(null); })
      .catch((cause: unknown) => {
        setListError(cause instanceof Error ? cause.message : 'Could not load the tables');
      });
  }, []);

  useEffect(load, [load]);

  // A seat survives a reload, so find it before showing the floor - otherwise a player
  // who refreshed mid-hand would be looking at a table list while their clock ran.
  useEffect(() => {
    void fetch('/api/tables/mine', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((mine) => { if (mine?.roomId) setRoomId(mine.roomId); })
      .catch(() => { /* not seated; the floor is the right screen */ });
  }, []);

  if (roomId) {
    return (
      <LiveTable
        roomId={roomId}
        balance={balance}
        onBalance={onBalance}
        onLeave={() => { setRoomId(null); load(); }}
      />
    );
  }

  return (
    <div className="floor">
      <header className="floor__bar">
        <button className="floor__back" onClick={onBack} aria-label="Back to the lobby">
          ← Lobby
        </button>
        <div className="floor__titles">
          <h1>Shared tables</h1>
          <p>No-limit hold&rsquo;em · six seats · bots fill the empties</p>
        </div>
        <span className="floor__balance numeric">{formatChips(balance)}</span>
      </header>

      {listError && <p className="floor__error">{listError}</p>}

      <ul className="floor__tables">
        {(tables ?? []).map((table) => (
          <li key={table.id}>
            <button className="table-card" onClick={() => setRoomId(table.id)}>
              <span className="table-card__name">{table.name}</span>
              <span className="table-card__blinds numeric">
                {formatChips(table.smallBlind)} / {formatChips(table.bigBlind)}
              </span>
              <span className="table-card__seats">
                {table.seated} of {table.seats} seats
                {table.humans > 0 && ` · ${table.humans} ${table.humans === 1 ? 'player' : 'players'}`}
              </span>
              <span className="table-card__buyin">
                Buy in {formatChips(table.minBuyIn)}–{formatChips(table.maxBuyIn)}
              </span>
            </button>
          </li>
        ))}
        {tables !== null && tables.length === 0 && (
          <li className="floor__empty">No tables are open right now.</li>
        )}
        {tables === null && !listError && <li className="floor__empty">Loading the floor…</li>}
      </ul>

      <p className="floor__note">
        Your buy-in leaves your balance when you sit and comes back, plus or minus, when
        you stand up. Disconnecting does not free your chips — the seat is held for a
        minute and the clock keeps running, which is the honest behaviour.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------- the table --

function LiveTable({
  roomId,
  balance,
  onBalance,
  onLeave,
}: {
  roomId: string;
  balance: number;
  onBalance: (balance: number) => void;
  onLeave: () => void;
}) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<TableStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [buyIn, setBuyIn] = useState(500);
  const [raiseTo, setRaiseTo] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const socketRef = useRef<TableSocket | null>(null);

  useEffect(() => {
    const socket = new TableSocket({
      onState: setRoom,
      onStatus: setStatus,
      onError: setError,
      onLeaving: () => setLeaving(true),
      onLeft: ({ balance: next }) => { onBalance(next); onLeave(); },
    });
    socketRef.current = socket;
    socket.watch(roomId);
    return () => { socket.close(); socketRef.current = null; };
    // Intentionally keyed on the room alone: re-running this on a new `onBalance`
    // identity would tear the socket down mid-hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // The balance in the header is the server's, not ours to compute.
  useEffect(() => {
    if (room) onBalance(room.balance);
  }, [room?.balance]);

  /**
   * The seat going away is what "we are out" means.
   *
   * Not a message. A stand-up requested mid-hand is honoured by the server's own clock
   * some seconds later, and there is no request in flight to answer at that point - the
   * first version waited for a `left` reply that could never arrive and sat on a table
   * it had already been removed from. The snapshot is the truth, so read it.
   */
  useEffect(() => {
    if (leaving && room !== null && room.you === null) onLeave();
  }, [leaving, room?.you]);

  // Keep the raise draft inside what the rules currently allow.
  useEffect(() => {
    if (!room?.yourTurn) return;
    setRaiseTo((current) =>
      Math.min(Math.max(current || room.minRaiseTo, room.minRaiseTo), room.maxRaiseTo),
    );
  }, [room]);

  const seated = room?.you !== null && room?.you !== undefined;
  const you = room && room.you !== null ? room.seats[room.you] : undefined;

  const act = (action: HoldemAction): void => {
    setError(null);
    socketRef.current?.act(action, action === 'raise' || action === 'bet' ? raiseTo : 0);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!room?.yourTurn || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const key = event.key.toLowerCase();
      const action = key === 'f' ? 'fold' : key === 'c' ? 'call' : key === 'r' ? 'raise' : null;
      if (action && room.actions.includes(action)) {
        event.preventDefault();
        act(action as HoldemAction);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!room) {
    return (
      <div className="floor floor--loading">
        <p>{STATUS_LABELS[status]}</p>
      </div>
    );
  }

  const affordable = Math.min(room.maxBuyIn, balance);

  return (
    <div className="floor">
      <header className="floor__bar">
        <button
          className="floor__back"
          onClick={() => (seated ? socketRef.current?.stand() : onLeave())}
          disabled={leaving}
        >
          {!seated ? '← Floor' : leaving ? 'Leaving…' : 'Stand up'}
        </button>
        <div className="floor__titles">
          <h1>{room.name}</h1>
          <p>
            {formatChips(room.smallBlind)} / {formatChips(room.bigBlind)} ·{' '}
            {STREET_LABELS[room.street] ?? room.street} · hand {room.handsPlayed}
          </p>
        </div>
        <span className={`floor__status floor__status--${status}`}>{STATUS_LABELS[status]}</span>
      </header>

      <div className="baize">
        <ol className="baize__seats">
          {room.seats.map((seat) => (
            <li
              key={seat.seat}
              className={[
                'pseat',
                seat.seat === room.you ? 'is-you' : '',
                seat.isTurn ? 'is-turn' : '',
                seat.folded ? 'is-folded' : '',
                !seat.occupied ? 'is-empty' : '',
                seat.kind === 'bot' ? 'is-bot' : '',
                seat.connected ? '' : 'is-away',
              ].filter(Boolean).join(' ')}
            >
              <div className="pseat__head">
                <span className="pseat__name">{seat.name}</span>
                {seat.seat === room.you && <span className="pseat__you">you</span>}
                {seat.isButton && <span className="pseat__button" title="Dealer button">D</span>}
              </div>

              {seat.kind === 'bot' && seat.style && (
                <span className="pseat__style">{seat.style}</span>
              )}
              {seat.kind === 'human' && !seat.connected && (
                <span className="pseat__away">away</span>
              )}

              <div className="pseat__cards">
                {!seat.occupied ? (
                  <span className="pseat__open">open seat</span>
                ) : seat.leaving ? (
                  <span className="pseat__open">standing up</span>
                ) : seat.waiting ? (
                  <span className="pseat__open">next hand</span>
                ) : seat.sittingOut ? (
                  <span className="pseat__open">sitting out</span>
                ) : seat.hole ? (
                  seat.hole.map((card, i) => <PlayingCard key={i} card={card} size="sm" />)
                ) : room.handInProgress ? (
                  // Face down means "dealt, and not yours to see". Drawing backs
                  // between hands would say that about cards that do not exist.
                  <>
                    <PlayingCard faceUp={false} size="sm" />
                    <PlayingCard faceUp={false} size="sm" />
                  </>
                ) : (
                  <span className="pseat__open">waiting</span>
                )}
              </div>

              {seat.handDescription && <span className="pseat__hand">{seat.handDescription}</span>}
              {seat.occupied && (
                <span className="pseat__chips numeric">{formatChips(seat.chips)}</span>
              )}
              {seat.bet > 0 && <span className="pseat__bet numeric">{formatChips(seat.bet)}</span>}
              {seat.lastAction && <span className="pseat__action">{seat.lastAction}</span>}
            </li>
          ))}
        </ol>

        <div className="baize__middle">
          <div className="baize__board">
            {Array.from({ length: 5 }, (_, i) => {
              const card = room.board[i];
              return card === undefined
                ? <span key={i} className="baize__slot" />
                : <PlayingCard key={i} card={card} size="md" />;
            })}
          </div>
          <div className="baize__pot">
            <span>Pot</span>
            <strong className="numeric">{formatChips(room.pot)}</strong>
          </div>
          {/* Shown rather than quietly deducted: it is the player's cost of playing. */}
          {room.result !== null && room.result.rake > 0 && (
            <p className="baize__rake">
              House took <span className="numeric">{formatChips(room.result.rake)}</span>
            </p>
          )}
          {room.deadline !== null && <Countdown deadline={room.deadline} turnMs={room.turnMs} />}
          {!room.handInProgress && room.nextHandAt !== null && (
            <p className="baize__next">Next hand shortly…</p>
          )}
        </div>
      </div>

      <div className="floor__controls">
        {!seated ? (
          <div className="sitdown">
            <label>
              Buy in
              <input
                type="range"
                min={room.minBuyIn}
                max={Math.max(room.minBuyIn, affordable)}
                step={10}
                value={Math.min(buyIn, affordable)}
                onChange={(event) => setBuyIn(Number(event.target.value))}
                disabled={affordable < room.minBuyIn}
              />
              <strong className="numeric">{formatChips(Math.min(buyIn, affordable))}</strong>
            </label>
            <button
              className="btn btn--primary"
              disabled={affordable < room.minBuyIn || status !== 'open'}
              onClick={() => {
                setError(null);
                socketRef.current?.sit(roomId, Math.min(buyIn, affordable));
              }}
            >
              {affordable < room.minBuyIn
                ? `You need ${formatChips(room.minBuyIn)} to sit`
                : `Take a seat for ${formatChips(Math.min(buyIn, affordable))}`}
            </button>
          </div>
        ) : room.yourTurn ? (
          <>
            <div className="floor__buttons">
              {room.actions.map((action) => (
                <button
                  key={action}
                  className={`btn ${action === 'fold' ? 'btn--ghost' : 'btn--primary'}`}
                  onClick={() => act(action as HoldemAction)}
                >
                  {ACTION_LABELS[action as HoldemAction]}
                  {action === 'call' && room.toCall > 0 && ` ${formatChips(room.toCall)}`}
                </button>
              ))}
            </div>

            {(room.actions.includes('raise') || room.actions.includes('bet')) && (
              <label className="floor__raise">
                <span>
                  {room.actions.includes('bet') ? 'Bet to' : 'Raise to'}
                  <strong className="numeric">{formatChips(raiseTo)}</strong>
                </span>
                <input
                  type="range"
                  min={room.minRaiseTo}
                  max={room.maxRaiseTo}
                  value={raiseTo}
                  onChange={(event) => setRaiseTo(Number(event.target.value))}
                />
              </label>
            )}
          </>
        ) : (
          <p className="floor__waiting">
            {room.handInProgress && room.toAct !== null
              ? `Waiting for ${room.seats[room.toAct]?.name ?? 'the table'}…`
              : you && you.chips <= 0
                ? 'Out of chips — stand up to reload.'
                : 'Waiting for the next hand…'}
          </p>
        )}

        {leaving && (
          <p className="floor__waiting">
            Standing up as soon as this hand finishes — your chips are still in the pot.
          </p>
        )}

        {error && <p className="floor__error">{error}</p>}

        {seated && !leaving && (
          <p className="floor__keys">
            <kbd>F</kbd> fold · <kbd>C</kbd> call · <kbd>R</kbd> raise
          </p>
        )}
      </div>

      {room.log.length > 0 && (
        <div className="floor__log">
          <h2>At the table</h2>
          <ol>{room.log.slice(-8).map((line, i) => <li key={i}>{line}</li>)}</ol>
        </div>
      )}
    </div>
  );
}

/**
 * The turn clock.
 *
 * Counts down to the server's `deadline` rather than from a local duration, so a client
 * that loaded late, slept, or has a skewed idea of the time still lands on the same
 * instant everyone else does.
 */
function Countdown({ deadline, turnMs }: { deadline: number; turnMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, deadline - now);
  const fraction = useMemo(() => Math.min(1, remaining / turnMs), [remaining, turnMs]);

  return (
    <div className={`clock ${remaining < 5_000 ? 'is-urgent' : ''}`}>
      <div className="clock__bar" style={{ transform: `scaleX(${fraction})` }} />
      <span className="clock__value numeric">{Math.ceil(remaining / 1_000)}s</span>
    </div>
  );
}
