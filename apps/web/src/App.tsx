import { useCallback, useEffect, useMemo, useState } from 'react';

import { BlackjackGame } from './games/BlackjackGame.js';
import { CrashGame } from './games/CrashGame.js';
import { DiceGame } from './games/DiceGame.js';
import { HoldemGame } from './games/HoldemGame.js';
import { LimboGame } from './games/LimboGame.js';
import { MinesGame } from './games/MinesGame.js';
import { RouletteGame } from './games/RouletteGame.js';
import { VideoPokerGame } from './games/VideoPokerGame.js';
import { SlotsGame } from './games/SlotsGame.js';
import { api } from './lib/httpTransport.js';
import { HttpTransport } from './lib/httpTransport.js';
import { LocalTransport } from './lib/localTransport.js';
import type { GameTransport } from './lib/transport.js';
import { Lobby } from './screens/Lobby.js';
import { SignIn } from './screens/SignIn.js';
import { Tables } from './screens/Tables.js';

const OFFLINE_KEY = 'websino.mode.practice.v1';
/**
 * Not a credential - just a note that this browser has signed in before. The session
 * cookie is httpOnly and therefore invisible here, so without this the app would probe
 * /api/me on every cold load and log a 404 for everyone who has never had an account.
 */
const HAD_SESSION_KEY = 'websino.hadSession.v1';

/**
 * Two transports behind one interface. Signing in swaps the HTTP transport in and the
 * game screens never learn which one they are talking to - that is what stops offline
 * from becoming a second, drifting implementation of the casino.
 *
 * The offline build is hard-wired to practice: it is a single file opened from disk,
 * so there is no server to sign in to and offering the form would be a dead end.
 */
const OFFLINE_BUILD = import.meta.env.VITE_OFFLINE === '1';

export function App() {
  const local = useMemo(() => new LocalTransport(), []);
  const house = useMemo(() => new HttpTransport(), []);

  const [practice, setPractice] = useState<boolean | null>(
    OFFLINE_BUILD ? true : readPracticePreference(),
  );
  const [balance, setBalance] = useState(0);
  const [screen, setScreen] = useState('lobby');

  const transport: GameTransport | null =
    practice === null ? null : practice ? local : house;

  const refresh = useCallback((active: GameTransport) => {
    void active.getBalance().then(setBalance).catch(() => setBalance(0));
  }, []);

  // Restore an existing session on load, so a refresh does not dump a signed-in
  // player back onto the sign-in form.
  useEffect(() => {
    if (OFFLINE_BUILD || practice !== null) return;
    if (!readFlag(HAD_SESSION_KEY)) return;
    void api.me()
      .then((me) => { setPractice(false); setBalance(me.balance); })
      .catch(() => { /* not signed in; leave the form up */ });
  }, [practice]);

  useEffect(() => {
    if (transport) refresh(transport);
  }, [transport, refresh]);

  if (!transport) {
    return (
      <SignIn
        onSignedIn={(_username, startingBalance) => {
          writeFlag(HAD_SESSION_KEY, true);
          writePracticePreference(false);
          setPractice(false);
          setBalance(startingBalance);
        }}
        onPractice={() => {
          writePracticePreference(true);
          setPractice(true);
        }}
      />
    );
  }

  const backToLobby = (): void => setScreen('lobby');
  const shared = { transport, balance, onBalance: setBalance, onBack: backToLobby };

  if (screen === 'dice') return <DiceGame {...shared} />;
  if (screen === 'limbo') return <LimboGame {...shared} />;
  if (screen === 'slots') return <SlotsGame {...shared} />;
  if (screen === 'blackjack') return <BlackjackGame {...shared} />;
  if (screen === 'crash') return <CrashGame {...shared} />;
  if (screen === 'roulette') return <RouletteGame {...shared} />;
  if (screen === 'mines') return <MinesGame {...shared} />;
  if (screen === 'videopoker') return <VideoPokerGame {...shared} />;
  if (screen === 'holdem') return <HoldemGame {...shared} />;
  // Shared tables talk to the server directly rather than through a transport: there is
  // no local dealer for a table other people are sitting at, and pretending otherwise
  // with a practice implementation would be a different game wearing the same name.
  if (screen === 'tables' && !practice) {
    return <Tables balance={balance} onBalance={setBalance} onBack={backToLobby} />;
  }

  return (
    <Lobby
      transport={transport}
      balance={balance}
      onOpen={setScreen}
      onTopUp={() => {
        if (transport.topUp) void transport.topUp().then(setBalance);
      }}
      onSignOut={
        OFFLINE_BUILD
          ? undefined
          : () => {
              void api.logout().catch(() => { /* already gone */ });
              writeFlag(HAD_SESSION_KEY, false);
              writePracticePreference(null);
              setPractice(null);
              setBalance(0);
            }
      }
    />
  );
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    /* private window */
  }
}

function readPracticePreference(): boolean | null {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function writePracticePreference(value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(OFFLINE_KEY);
    else localStorage.setItem(OFFLINE_KEY, value ? '1' : '0');
  } catch {
    /* private window; the choice just will not persist */
  }
}
