import { useState } from 'react';

import { api, ApiError } from '../lib/httpTransport.js';
import './SignIn.css';

/**
 * Sign in, or keep playing offline.
 *
 * Practice mode is offered as a first-class choice rather than a fallback, because it is
 * one: practice chips are a separate wallet that never syncs, and saying so here is more
 * honest than letting someone grind an offline balance and then discover it was never
 * going anywhere.
 */
export function SignIn({
  onSignedIn,
  onPractice,
}: {
  onSignedIn: (username: string, balance: number) => void;
  onPractice: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = mode === 'login'
        ? await api.login(username, password)
        : await api.register(username, password);
      onSignedIn(result.user.username, result.balance);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 0
          ? 'No server on the other end — you can still play in practice mode.'
          : cause instanceof Error ? cause.message : 'Something went wrong',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={(e) => void submit(e)}>
        <h1 className="signin__title">Websino</h1>
        <p className="signin__tagline">One chip stack. Every table. Provably fair.</p>

        <div className="signin__tabs" role="group" aria-label="Sign in or create an account">
          {(['login', 'register'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`signin__tab${mode === option ? ' is-active' : ''}`}
              onClick={() => { setMode(option); setError(null); }}
            >
              {option === 'login' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>

        <label className="signin__field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            maxLength={64}
          />
        </label>

        <label className="signin__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            maxLength={200}
          />
        </label>

        {error && <p className="signin__error">{error}</p>}

        <button className="btn btn--primary signin__submit" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        <button type="button" className="btn btn--ghost signin__practice" onClick={onPractice}>
          Play offline in practice mode
        </button>

        <p className="signin__note">
          Play money only — no purchases, no cash-outs, no real currency anywhere.
          Practice chips stay in this browser and never reach an account.
        </p>
      </form>
    </div>
  );
}
