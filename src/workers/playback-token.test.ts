import { describe, expect, it } from 'vitest';
import {
  signPlaybackToken,
  verifyPlaybackToken,
  rewriteM3u8,
  TOKEN_TTL_SECONDS,
} from './playback-token';

const ENV = { DB: {} as D1Database, BETTER_AUTH_SECRET: 'test-secret-32-chars-long-here!!' };

describe('signPlaybackToken / verifyPlaybackToken', () => {
  it('round-trips: a freshly signed token verifies for the same videoId', async () => {
    const token = await signPlaybackToken('vid-abc', ENV);
    const result = await verifyPlaybackToken(token, 'vid-abc', ENV);
    expect(result.valid).toBe(true);
  });

  it('rejects a token whose vid claim does not match the requested videoId', async () => {
    const token = await signPlaybackToken('vid-abc', ENV);
    const result = await verifyPlaybackToken(token, 'vid-xyz', ENV);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('video mismatch');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signPlaybackToken('vid-abc', { ...ENV, BETTER_AUTH_SECRET: 'other-secret' });
    const result = await verifyPlaybackToken(token, 'vid-abc', ENV);
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed token string', async () => {
    const result = await verifyPlaybackToken('not.a.jwt', 'vid-abc', ENV);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('produces a token that carries a valid exp claim ~TTL seconds from now', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signPlaybackToken('vid-ttl', ENV);
    const after = Math.floor(Date.now() / 1000);

    // Decode without verifying signature to inspect claims.
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    expect(payload.exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
    expect(payload.exp).toBeLessThanOrEqual(after + TOKEN_TTL_SECONDS + 2);
  });
});

describe('rewriteM3u8', () => {
  const origin = 'https://spooool.com';
  const tok = 'test-token';

  it('rewrites relative segment lines to absolute Worker URLs with token', () => {
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:10',
      '#EXTINF:10.0,',
      'index0.ts',
      '#EXTINF:10.0,',
      'index1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = rewriteM3u8(manifest, 'vid1', '720p/', tok, origin);
    const lines = out.split('\n');
    expect(lines[4]).toBe(`${origin}/api/videos/vid1/hls/720p/index0.ts?t=${tok}`);
    expect(lines[6]).toBe(`${origin}/api/videos/vid1/hls/720p/index1.ts?t=${tok}`);
    // Comment lines are untouched.
    expect(lines[0]).toBe('#EXTM3U');
    expect(lines[3]).toBe('#EXTINF:10.0,');
  });

  it('rewrites sub-playlist lines in a master manifest', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      '360p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2800000',
      '720p/index.m3u8',
    ].join('\n');

    const out = rewriteM3u8(master, 'vid1', '', tok, origin);
    const lines = out.split('\n');
    expect(lines[2]).toBe(`${origin}/api/videos/vid1/hls/360p/index.m3u8?t=${tok}`);
    expect(lines[4]).toBe(`${origin}/api/videos/vid1/hls/720p/index.m3u8?t=${tok}`);
  });

  it('preserves existing query params on relative URLs', () => {
    const manifest = '#EXTM3U\n#EXTINF:5.0,\nfrag.ts?v=2\n#EXT-X-ENDLIST';
    const out = rewriteM3u8(manifest, 'vid1', 'hd/', tok, origin);
    expect(out.split('\n')[2]).toBe(`${origin}/api/videos/vid1/hls/hd/frag.ts?t=${tok}&v=2`);
  });

  it('appends token to absolute https:// segment URLs', () => {
    const manifest = '#EXTM3U\n#EXTINF:10.0,\nhttps://cdn.example.com/seg0.ts\n#EXT-X-ENDLIST';
    const out = rewriteM3u8(manifest, 'vid1', '', tok, origin);
    expect(out.split('\n')[2]).toBe(`https://cdn.example.com/seg0.ts?t=${tok}`);
  });

  it('preserves empty lines and comment-only manifests unchanged', () => {
    const manifest = '#EXTM3U\n\n#EXT-X-ENDLIST';
    const out = rewriteM3u8(manifest, 'vid1', '', tok, origin);
    expect(out).toBe(manifest);
  });
});
