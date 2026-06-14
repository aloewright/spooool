// Inline SVG icons used as card placeholders + suggestion glyphs. All four
// share a single mark: a black squircle with a red record dot in the
// middle. The differentiation between Upload / Channel / Play / Placeholder
// is now carried by the surrounding label, not the glyph.

type IconProps = {
  className?: string;
  style?: React.CSSProperties;
  // Aspect-ratio container so the placeholder sits where a thumbnail would.
  thumbnail?: boolean;
};

const SQUIRCLE_FILL = '#000';
const RECORD_FILL = '#e11d48';

function ThumbnailFrame({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16/9',
        background: '#fff',
        borderRadius: 8,
        marginBottom: 'var(--space-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function RecordMark({
  size = 28,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      {/* Black squircle (rounded square) */}
      <rect x="2" y="2" width="20" height="20" rx="6" ry="6" fill={SQUIRCLE_FILL} />
      {/* Red record dot */}
      <circle cx="12" cy="12" r="4.25" fill={RECORD_FILL} />
    </svg>
  );
}

/** Generic video placeholder — shown when a video card has no thumbnail. */
export function VideoPlaceholderIcon({ thumbnail = true, className, style }: IconProps): JSX.Element {
  const svg = <RecordMark size={36} className={className} />;
  return thumbnail ? <ThumbnailFrame style={style}>{svg}</ThumbnailFrame> : svg;
}

/** Upload glyph — record-mark variant. */
export function UploadIcon({ className, style }: IconProps): JSX.Element {
  return <RecordMark className={className} style={style} />;
}

/** Channel glyph — record-mark variant. */
export function ChannelIcon({ className, style }: IconProps): JSX.Element {
  return <RecordMark className={className} style={style} />;
}

/** Play glyph — record-mark variant. */
export function PlayIcon({ className, style }: IconProps): JSX.Element {
  return <RecordMark className={className} style={style} />;
}

/** Pre-Production glyph — pen/script document. */
export function ScriptIcon({ className, style }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={28}
      height={28}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

/** Production glyph — clapperboard. */
export function ClapperIcon({ className, style }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={28}
      height={28}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <rect x="2" y="8" width="20" height="13" rx="2" />
      <path d="M2 8l4-5h12l4 5" />
      <line x1="7" y1="3" x2="6" y2="8" />
      <line x1="12" y1="3" x2="11" y2="8" />
      <line x1="17" y1="3" x2="16" y2="8" />
    </svg>
  );
}

/** Post-Production glyph — film reel. */
export function ReelIcon({ className, style }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={28}
      height={28}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="9" />
      <line x1="12" y1="15" x2="12" y2="22" />
      <line x1="2" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="22" y2="12" />
    </svg>
  );
}
