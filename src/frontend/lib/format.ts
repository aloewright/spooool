export function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const s = (n / 1_000_000).toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}M`;
  }
  if (n >= 10_000) return `${Math.floor(n / 1_000)}K`;
  if (n >= 1_000) {
    const s = (n / 1_000).toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}K`;
  }
  return String(n);
}
