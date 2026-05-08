#!/usr/bin/env node
// ALO-142: end-to-end verification that a Cloudflare Stream HLS master
// manifest exposes multiple ABR renditions and that a throttle ladder
// would step down monotonically as bandwidth shrinks.
//
// Usage:
//   node scripts/verify-hls-abr.mjs <master-manifest-url>
//   node scripts/verify-hls-abr.mjs <stream-video-id>
//
// A bare video id is expanded to the canonical Stream HLS URL:
//   https://videodelivery.net/<id>/manifest/video.m3u8
//
// Exits non-zero if the manifest has fewer than 2 variants or if the
// throttle ladder is not strictly monotonic in resolution.

const STREAM_INF_RE = /^#EXT-X-STREAM-INF:(.*)$/;

function parseAttributes(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function parseHlsMaster(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].startsWith('#EXTM3U')) return [];
  const variants = [];
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
    let resolution = null;
    if (attrs.RESOLUTION) {
      const [w, h] = attrs.RESOLUTION.split('x').map(Number);
      if (Number.isFinite(w) && Number.isFinite(h)) resolution = { width: w, height: h };
    }
    variants.push({
      bandwidth: Number(attrs.BANDWIDTH ?? '0'),
      resolution,
      codecs: attrs.CODECS ?? null,
      uri,
    });
  }
  return variants;
}

function pickVariantForBandwidth(variants, ceilingBps) {
  const eligible = variants.filter((v) => v.bandwidth > 0 && v.bandwidth <= ceilingBps);
  if (eligible.length === 0) {
    return [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0] ?? null;
  }
  return eligible.reduce((best, cur) => (cur.bandwidth > best.bandwidth ? cur : best));
}

function resolveUrl(arg) {
  if (/^https?:\/\//i.test(arg)) return arg;
  if (/^[a-f0-9]{20,}$/i.test(arg)) {
    return `https://videodelivery.net/${arg}/manifest/video.m3u8`;
  }
  return arg;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: verify-hls-abr.mjs <master-manifest-url | stream-video-id>');
    process.exit(2);
  }
  const url = resolveUrl(arg);
  console.log(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  const variants = parseHlsMaster(text);
  if (variants.length < 2) {
    console.error(`FAIL: expected >=2 ABR variants, got ${variants.length}`);
    process.exit(1);
  }
  console.log(`found ${variants.length} variants:`);
  for (const v of variants) {
    const res = v.resolution ? `${v.resolution.width}x${v.resolution.height}` : '?';
    console.log(`  ${(v.bandwidth / 1000).toFixed(0).padStart(6)} kbps  ${res.padEnd(10)}  ${v.uri}`);
  }

  const ceilings = [10_000_000, 3_000_000, 1_500_000, 700_000, 250_000];
  const picks = ceilings.map((c) => ({ c, v: pickVariantForBandwidth(variants, c) }));
  console.log('\nthrottle ladder (ABR simulation):');
  for (const { c, v } of picks) {
    const r = v?.resolution ? `${v.resolution.height}p` : '?';
    console.log(`  ceiling ${(c / 1_000_000).toFixed(2)} Mbps -> ${r} @ ${v?.bandwidth ?? 0} bps`);
  }
  const heights = picks.map((p) => p.v?.resolution?.height ?? 0);
  for (let i = 1; i < heights.length; i++) {
    if (heights[i] > heights[i - 1]) {
      console.error('FAIL: throttle ladder is not monotonic');
      process.exit(1);
    }
  }
  console.log('\nOK: manifest exposes multiple ABR variants and ladder is monotonic.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
