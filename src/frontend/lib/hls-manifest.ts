// ALO-142: small parser for HLS master playlists, used as a sanity check that
// Cloudflare Stream is returning multiple ABR variants. Real ABR switching is
// handled by hls.js (ALO-204) at runtime — or by Safari's native HLS stack on
// browsers where `canPlayType('application/vnd.apple.mpegurl')` is non-empty.

export interface HlsVariant {
  bandwidth: number;
  resolution: { width: number; height: number } | null;
  codecs: string | null;
  uri: string;
}

const STREAM_INF_RE = /^#EXT-X-STREAM-INF:(.*)$/;

function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on commas not inside quotes.
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const key = m[1];
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function parseHlsMaster(text: string): HlsVariant[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].startsWith('#EXTM3U')) return [];

  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = STREAM_INF_RE.exec(lines[i]);
    if (!match) continue;
    const attrs = parseAttributes(match[1]);
    let uri = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next.length === 0 || next.startsWith('#')) continue;
      uri = next;
      break;
    }
    if (!uri) continue;

    const bandwidth = Number(attrs.BANDWIDTH ?? '0');
    let resolution: HlsVariant['resolution'] = null;
    if (attrs.RESOLUTION) {
      const [w, h] = attrs.RESOLUTION.split('x').map((n) => Number(n));
      if (Number.isFinite(w) && Number.isFinite(h)) {
        resolution = { width: w, height: h };
      }
    }
    variants.push({
      bandwidth,
      resolution,
      codecs: attrs.CODECS ?? null,
      uri,
    });
  }
  return variants;
}

// Picks the best variant for a given downlink bitrate ceiling, simulating what
// an ABR algorithm would do in the steady state. Used in tests to check that
// throttling steps the renditions down monotonically.
export function pickVariantForBandwidth(
  variants: HlsVariant[],
  ceilingBps: number,
): HlsVariant | null {
  const eligible = variants.filter((v) => v.bandwidth > 0 && v.bandwidth <= ceilingBps);
  if (eligible.length === 0) {
    return [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0] ?? null;
  }
  return eligible.reduce((best, cur) => (cur.bandwidth > best.bandwidth ? cur : best));
}
