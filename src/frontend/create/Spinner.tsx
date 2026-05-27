// Small CSS-only spinner used by the prompt-to-video flow. Sized via the
// `size` prop (defaults to 24px). Styles live in strand.css as `.spinner`.

interface SpinnerProps {
  size?: number;
  label?: string;
  inline?: boolean;
}

export function Spinner({ size = 24, label, inline }: SpinnerProps): JSX.Element {
  return (
    <span
      className={inline ? 'spinner spinner--inline' : 'spinner'}
      style={{ '--spinner-size': `${size}px` } as React.CSSProperties}
      role="status"
      aria-live="polite"
      aria-label={label ?? 'Loading'}
    >
      <span className="spinner__ring" aria-hidden="true" />
      {label ? <span className="spinner__label">{label}</span> : null}
    </span>
  );
}
