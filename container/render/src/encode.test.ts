import { describe, expect, it } from 'vitest';
import { buildMasterPlaylist } from './encode';

describe('encode HLS helpers (ALO-136)', () => {
  it('buildMasterPlaylist lists three adaptive variants', () => {
    const master = buildMasterPlaylist();
    expect(master).toContain('#EXTM3U');
    expect(master).toContain('1080p.m3u8');
    expect(master).toContain('720p.m3u8');
    expect(master).toContain('360p.m3u8');
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=');
  });
});
