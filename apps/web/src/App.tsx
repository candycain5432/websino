import { useEffect, useMemo, useState } from 'react';

import { DiceGame } from './games/DiceGame.js';
import { LimboGame } from './games/LimboGame.js';
import { LocalTransport } from './lib/localTransport.js';
import { Lobby } from './screens/Lobby.js';

/**
 * Phase 1 runs entirely on the local transport, so the whole casino works with no
 * server at all. Signing in swaps in an HTTP transport against the same interface -
 * the game screens never learn which one they are talking to.
 */
export function App() {
  const transport = useMemo(() => new LocalTransport(), []);
  const [balance, setBalance] = useState(0);
  const [screen, setScreen] = useState<string>('lobby');

  useEffect(() => {
    void transport.getBalance().then(setBalance);
  }, [transport]);

  const backToLobby = (): void => setScreen('lobby');
  const shared = { transport, balance, onBalance: setBalance, onBack: backToLobby };

  if (screen === 'dice') return <DiceGame {...shared} />;
  if (screen === 'limbo') return <LimboGame {...shared} />;

  return (
    <Lobby
      transport={transport}
      balance={balance}
      onOpen={setScreen}
      onTopUp={() => void transport.topUp().then(setBalance)}
    />
  );
}
