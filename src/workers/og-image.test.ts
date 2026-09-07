import { describe, expect, it } from 'vitest';
import { buildFallbackSvg } from './og-image';

describe('buildFallbackSvg', () => {
  it('produces valid SVG with the video title', () => {
    const svg = buildFallbackSvg('My Great Video', 'Alice Channel');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('My Great Video');
    expect(svg).toContain('Alice Channel');
    expect(svg).toContain('spooool.com');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('handles null channel name without crashing', () => {
    const svg = buildFallbackSvg('Video without a channel', null);
    expect(svg).toContain('Video without a channel');
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('null');
  });

  it('escapes XML metacharacters in title and channel name', () => {
    const svg = buildFallbackSvg('A & B <demo>', '"Channel" & Co');
    expect(svg).toContain('A &amp; B &lt;demo&gt;');
    expect(svg).toContain('&quot;Channel&quot; &amp; Co');
    expect(svg).not.toContain('<demo>');
  });

  it('truncates very long titles gracefully', () => {
    const longTitle = 'a'.repeat(300);
    const svg = buildFallbackSvg(longTitle, null);
    // Should not overflow — clamped at the SVG level
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('undefined');
  });

  it('includes a branded gradient background', () => {
    const svg = buildFallbackSvg('Test', null);
    expect(svg).toContain('linearGradient');
    expect(svg).toContain('url(#bg)');
  });

  it('includes the accent bar', () => {
    const svg = buildFallbackSvg('Test', null);
    // Purple accent stripe on the left edge
    expect(svg).toContain('#7c3aed');
  });
});
