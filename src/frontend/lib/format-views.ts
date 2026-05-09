// ALO-144: humanize raw view counts for display. Mirrors the YouTube-style
// "1.2K / 3.4M / 5.6B" cadence so a card glance is consistent regardless of
// magnitude. Anything <1000 is shown verbatim (no decimals, no abbreviation).
const UNITS: ReadonlyArray<{ threshold: number; suffix: string }> = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
];

export function formatViewCount(raw: number | null | undefined): string {
  const n = Number.isFinite(raw) ? Math.max(0, Math.floor(raw as number)) : 0;
  for (const unit of UNITS) {
    if (n >= unit.threshold) {
      const scaled = n / unit.threshold;
      // One decimal for <100 (e.g. 1.2K), zero decimals once we've crossed
      // 100 of the same unit (e.g. 123K) — matches what most viewers expect
      // and keeps the layout from shifting between cards.
      const formatted = scaled >= 100 ? Math.floor(scaled).toString() : scaled.toFixed(1);
      // Drop a trailing ".0" so "1.0K" renders as "1K".
      return `${formatted.replace(/\.0$/, '')}${unit.suffix}`;
    }
  }
  return String(n);
}

export function formatViews(raw: number | null | undefined): string {
  const formatted = formatViewCount(raw);
  return formatted === '1' ? '1 view' : `${formatted} views`;
}
