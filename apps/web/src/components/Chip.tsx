import './Chip.css';

const KNOWN = [1, 5, 25, 100, 500, 2500] as const;

function label(denomination: number): string {
  if (denomination >= 1000) {
    const k = denomination / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(denomination);
}

export function Chip({
  denomination,
  size = 48,
  selected = false,
}: {
  denomination: number;
  size?: number;
  selected?: boolean;
}) {
  const known = (KNOWN as readonly number[]).includes(denomination) ? denomination : 1;
  return (
    <span
      className={`chip chip--${known}${selected ? ' chip--selected' : ''}`}
      style={{ '--chip-size': `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="chip__face">{label(denomination)}</span>
    </span>
  );
}
