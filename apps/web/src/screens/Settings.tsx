/**
 * Settings.
 *
 * One preference so far, and it is worth being careful about how it is *chosen* rather
 * than how it is stored. A theme is not a value you can read off a name - "Red Velvet"
 * tells you almost nothing - so the choice is made by looking at rooms, not by reading a
 * list. Each option shows the felt, the page behind it and the metal it is trimmed in,
 * laid out the way they actually sit on a table.
 *
 * And picking one applies it immediately, before the save has been acknowledged. The room
 * is the preview; a separate one would be a smaller, worse version of the thing you are
 * about to be looking at anyway. If the save fails the screen says so and puts the old
 * choice back, which is the only case where anything is undone.
 */

import { useEffect, useState } from 'react';

import { formatChips } from '../lib/format.js';
import { applyTheme, DEFAULT_THEME, THEMES, type ThemeId } from '../lib/theme.js';
import type { GameTransport } from '../lib/transport.js';
import './Settings.css';

export function Settings({
  transport,
  balance,
  onBack,
}: {
  transport: GameTransport;
  balance: number;
  onBack: () => void;
}) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever is stored wins over whatever the cache painted at boot.
  useEffect(() => {
    let live = true;
    void transport.getSettings()
      .then((settings) => {
        if (!live) return;
        setTheme(settings.theme);
        applyTheme(settings.theme);
      })
      .catch(() => { /* keep whatever the page is already wearing */ });
    return () => { live = false; };
  }, [transport]);

  const choose = async (next: ThemeId): Promise<void> => {
    if (next === theme || saving) return;
    const previous = theme;
    setTheme(next);
    applyTheme(next);
    setSaving(true);
    setError(null);
    try {
      await transport.setSettings({ theme: next });
    } catch (cause) {
      setTheme(previous);
      applyTheme(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const practice = transport.mode === 'practice';

  return (
    <div className="settings">
      <header className="settings__bar">
        <button className="settings__back" onClick={onBack} aria-label="Back to the lobby">
          ← Lobby
        </button>
        <span className="settings__here">Settings</span>
        <span className="settings__balance numeric">{formatChips(balance)}</span>
      </header>

      <section className="settings__section">
        <h1 className="settings__title">The room</h1>
        <p className="settings__note">
          {practice
            ? 'Practice mode has no account, so this is remembered in this browser only.'
            : 'Saved to your account, so it follows you to any browser you sign in from.'}
        </p>

        <ul className="settings__rooms" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <li key={option.id}>
              <button
                role="radio"
                aria-checked={theme === option.id}
                className={`room${theme === option.id ? ' is-on' : ''}`}
                onClick={() => void choose(option.id)}
                disabled={saving}
                style={{
                  '--room-felt': option.swatch[0],
                  '--room-deep': option.swatch[1],
                  '--room-metal': option.swatch[2],
                } as React.CSSProperties}
              >
                {/*
                  * A table, not three squares in a row.
                  *
                  * The swatches are laid out the way the colours actually meet on screen -
                  * the page behind, an oval of felt on it, a rule of metal across the
                  * felt - because what matters about a palette is not the three colours
                  * but whether they separate when stacked, which a row of squares cannot
                  * show you.
                  */}
                <span className="room__scene" aria-hidden="true">
                  <span className="room__felt" />
                  <span className="room__metal" />
                </span>
                <span className="room__name">{option.name}</span>
                <span className="room__blurb">{option.blurb}</span>
              </button>
            </li>
          ))}
        </ul>

        {error && <p className="settings__error">{error}</p>}
      </section>

      <footer className="settings__footer">
        Colour only. Nothing here changes a payout, a paytable or the odds of anything.
      </footer>
    </div>
  );
}
