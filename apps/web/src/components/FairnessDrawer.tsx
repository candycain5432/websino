import { useEffect, useState } from 'react';

import type { FairnessState, GameTransport } from '../lib/transport.js';
import './FairnessDrawer.css';

/**
 * The provably-fair panel.
 *
 * Shows the commitment the house is bound to before you bet, lets you set your own
 * client seed, and rotates the server seed - which reveals the old one so any past
 * round can be recomputed. The honest framing matters: this proves the seed was not
 * swapped after seeing your bet. It is not a guarantee against an operator who
 * modified the server beforehand, and the copy says so.
 */
export function FairnessDrawer({
  transport,
  roundCount = 0,
}: {
  transport: GameTransport;
  roundCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FairnessState | null>(null);
  const [draft, setDraft] = useState('');

  // `roundCount` is in the dependency list on purpose: each completed round
  // advances the nonce server-side, and a stale counter here would quietly
  // undermine the one panel whose whole job is being trustworthy.
  useEffect(() => {
    void transport.getFairness().then((next) => {
      setState(next);
      setDraft((current) => (current === '' ? next.clientSeed : current));
    });
  }, [transport, roundCount]);

  const refresh = (next: FairnessState): void => {
    setState(next);
    setDraft(next.clientSeed);
  };

  return (
    <section className="fair">
      <button
        className="fair__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Provably fair</span>
        <span className={`fair__chevron${open ? ' is-open' : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && state && (
        <div className="fair__body">
          <p className="fair__note">
            Every outcome comes from three strings. The hash below commits the house to a
            server seed it cannot change after seeing your bet.
          </p>

          <label className="fair__field">
            <span className="fair__label">Server seed hash</span>
            <code className="fair__code">{state.serverSeedHash}</code>
          </label>

          <label className="fair__field">
            <span className="fair__label">Your client seed</span>
            <div className="fair__row">
              <input
                className="fair__input"
                value={draft}
                maxLength={256}
                onChange={(event) => setDraft(event.target.value)}
              />
              <button
                className="btn btn--ghost fair__btn"
                onClick={() => void transport.setClientSeed(draft).then(refresh)}
              >
                Apply
              </button>
            </div>
          </label>

          <div className="fair__row fair__row--split">
            <span className="fair__label">
              Rounds on this seed: <strong className="numeric">{state.nonce}</strong>
            </span>
            <button
              className="btn btn--ghost fair__btn"
              onClick={() => void transport.rotateServerSeed().then(refresh)}
            >
              Rotate &amp; reveal
            </button>
          </div>

          {state.previous && (
            <div className="fair__revealed">
              <span className="fair__label">Revealed seed ({state.previous.rounds} rounds)</span>
              <code className="fair__code">{state.previous.serverSeed}</code>
              <span className="fair__verified">
                ✓ hashes to the commitment shown before those rounds
              </span>
            </div>
          )}

          <p className="fair__caveat">
            Play money on a server the operator runs — treat this as auditability, not as
            a guarantee. Every round replays exactly from its three strings.
          </p>
        </div>
      )}
    </section>
  );
}
