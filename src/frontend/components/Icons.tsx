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
