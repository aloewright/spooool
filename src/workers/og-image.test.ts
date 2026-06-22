import { describe, expect, it } from 'vitest';
import { buildOgImageSvg } from './og-image';

describe('buildOgImageSvg', () => {
  it('produces a valid SVG root element', () => {
    const svg = buildOgImageSvg({ title: 'My Video', channel_name: 'Alice', thumbnail_url: null });
    expect(svg).toMatch(/^<svg\s/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it('includes the video title in the output', () => {
    const svg = buildOgImageSvg({ title: 'Hello World', channel_name: null, thumbnail_url: null });
    expect(svg).toContain('Hello World');
  });

  it('escapes XML metacharacters in the title', () => {
    const svg = buildOgImageSvg({
      title: 'A & B <em>test</em>',
      channel_name: null,
      thumbnail_url: null,
    });
    expect(svg).toContain('A &amp; B');
    expect(svg).toContain('&lt;em&gt;');
    expect(svg).not.toContain('<em>');
  });

  it('includes the channel name in the footer', () => {
    const svg = buildOgImageSvg({ title: 'T', channel_name: 'My Channel', thumbnail_url: null });
    expect(svg).toContain('My Channel');
  });

  it('includes the spooool.io branding', () => {
    const svg = buildOgImageSvg({ title: 'T', channel_name: null, thumbnail_url: null });
    expect(svg).toContain('spooool.io');
  });

  it('embeds the thumbnail URL when provided', () => {
    const url = 'https://thumbs.example/vid.jpg';
    const svg = buildOgImageSvg({ title: 'T', channel_name: null, thumbnail_url: url });
    expect(svg).toContain(url);
    expect(svg).toContain('<image href=');
  });

  it('renders a play-icon placeholder when no thumbnail is provided', () => {
    const svg = buildOgImageSvg({ title: 'T', channel_name: null, thumbnail_url: null });
    expect(svg).not.toContain('<image href=');
    expect(svg).toContain('▶');
  });

  it('wraps long titles across multiple text elements', () => {
    const long = 'A'.repeat(10) + ' ' + 'B'.repeat(10) + ' ' + 'C'.repeat(10) + ' ' + 'D'.repeat(10);
    const svg = buildOgImageSvg({ title: long, channel_name: null, thumbnail_url: null });
    const textMatches = svg.match(/<text/g) ?? [];
    expect(textMatches.length).toBeGreaterThan(2);
  });
});
