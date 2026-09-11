import { CHIP_DENOMINATIONS, MAX_BET } from '@websino/engine';

import { formatChips } from '../lib/format.js';
import { Chip } from './Chip.js';
import './BetControls.css';

/** Stake selector: chip rail plus the usual halve/double/max shortcuts. */
export function BetControls({
  bet,
  balance,
  disabled,
  onChange,
}: {
  bet: number;
  balance: number;
  disabled: boolean;
  onChange: (bet: number) => void;
}) {
  const cap = Math.max(1, Math.min(MAX_BET, balance));
  const clamp = (value: number): number => Math.max(1, Math.min(Math.floor(value), cap));

  return (
    <div className="bet">
      <div className="bet__header">
        <label className="bet__label" htmlFor="bet-amount">
          Bet
        </label>
        <input
          id="bet-amount"
          className="bet__input numeric"
          type="number"
          inputMode="numeric"
          min={1}
          max={cap}
          value={bet}
          disabled={disabled}
          onChange={(event) => onChange(clamp(Number(event.target.value) || 1))}
        />
      </div>

      <div className="bet__rail">
        {CHIP_DENOMINATIONS.map((denomination) => (
          <button
            key={denomination}
            className="bet__chip"
            disabled={disabled || denomination > cap}
            onClick={() => onChange(clamp(bet + denomination))}
            aria-label={`Add ${formatChips(denomination)} chips`}
          >
            <Chip denomination={denomination} size={42} />
          </button>
        ))}
      </div>

      <div className="bet__quick">
        <button className="btn btn--ghost bet__quick-btn" disabled={disabled} onClick={() => onChange(1)}>
          Clear
        </button>
        <button className="btn btn--ghost bet__quick-btn" disabled={disabled} onClick={() => onChange(clamp(bet / 2))}>
          ½
        </button>
        <button className="btn btn--ghost bet__quick-btn" disabled={disabled} onClick={() => onChange(clamp(bet * 2))}>
          2×
        </button>
        <button className="btn btn--ghost bet__quick-btn" disabled={disabled} onClick={() => onChange(cap)}>
          Max
        </button>
      </div>
    </div>
  );
}
