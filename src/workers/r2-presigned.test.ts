import { describe, expect, it } from 'vitest';
import { presignR2GetUrl } from './r2-presigned';

// Fixed clock so signatures are deterministic.
const NOW = new Date('2026-01-15T12:00:00Z');

const OPTS = {
  accountId: 'testaccount123',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  bucketName: 'spooool-videos',
  key: 'user123/vid456/video.mp4',
  now: NOW,
};

describe('presignR2GetUrl', () => {
  it('returns an https R2 URL', async () => {
    const url = await presignR2GetUrl(OPTS);
    expect(url).toMatch(/^https:\/\/testaccount123\.r2\.cloudflarestorage\.com\//);
  });

  it('includes bucket and key in the path', async () => {
    const url = await presignR2GetUrl(OPTS);
    const { pathname } = new URL(url);
    expect(pathname).toBe('/spooool-videos/user123/vid456/video.mp4');
  });

  it('contains required SigV4 query params', async () => {
    const url = await presignR2GetUrl(OPTS);
    const params = new URL(url).searchParams;
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Credential')).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(params.get('X-Amz-Date')).toBe('20260115T120000Z');
    expect(params.get('X-Amz-Expires')).toBe('3600');
    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects custom expiresInSeconds', async () => {
    const url = await presignR2GetUrl({ ...OPTS, expiresInSeconds: 300 });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('is deterministic for the same inputs', async () => {
    const url1 = await presignR2GetUrl(OPTS);
    const url2 = await presignR2GetUrl(OPTS);
    expect(url1).toBe(url2);
  });

  it('encodes special characters in the key', async () => {
    const url = await presignR2GetUrl({ ...OPTS, key: 'user/my video (1).mp4' });
    const { pathname } = new URL(url);
    expect(pathname).toBe('/spooool-videos/user/my%20video%20(1).mp4');
  });

  it('produces different signatures for different keys', async () => {
    const url1 = await presignR2GetUrl({ ...OPTS, key: 'a/b.mp4' });
    const url2 = await presignR2GetUrl({ ...OPTS, key: 'a/c.mp4' });
    const sig1 = new URL(url1).searchParams.get('X-Amz-Signature');
    const sig2 = new URL(url2).searchParams.get('X-Amz-Signature');
    expect(sig1).not.toBe(sig2);
  });
});
