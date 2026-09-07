import { describe, expect, it } from 'vitest';
import { generateR2PresignedUrl } from './r2-presign';

// Fixed clock so the expected URL is deterministic.
const FIXED_NOW = new Date('2026-09-07T12:00:00.000Z');

const OPTS = {
  accountId: 'abc123',
  bucketName: 'spooool-videos',
  key: 'user-1/video-abc/clip.mp4',
  accessKeyId: 'TESTKEY',
  secretAccessKey: 'TESTSECRET',
  expiresIn: 3600,
  now: FIXED_NOW,
};

describe('generateR2PresignedUrl', () => {
  it('returns an https URL targeting the R2 S3 endpoint', async () => {
    const url = await generateR2PresignedUrl(OPTS);
    expect(url).toMatch(/^https:\/\/abc123\.r2\.cloudflarestorage\.com\//);
  });

  it('embeds the bucket and key in the path', async () => {
    const url = await generateR2PresignedUrl(OPTS);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/spooool-videos/user-1/video-abc/clip.mp4');
  });

  it('includes required AWS4 query parameters', async () => {
    const url = await generateR2PresignedUrl(OPTS);
    const params = new URL(url).searchParams;
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Expires')).toBe('3600');
    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
    expect(params.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('embeds the credential scope with the access key', async () => {
    const url = await generateR2PresignedUrl(OPTS);
    const credential = new URL(url).searchParams.get('X-Amz-Credential') ?? '';
    expect(credential).toMatch(/^TESTKEY\/20260907\/auto\/s3\/aws4_request$/);
  });

  it('is deterministic for the same inputs', async () => {
    const [a, b] = await Promise.all([
      generateR2PresignedUrl(OPTS),
      generateR2PresignedUrl(OPTS),
    ]);
    expect(a).toBe(b);
  });

  it('changes when the key changes', async () => {
    const url1 = await generateR2PresignedUrl(OPTS);
    const url2 = await generateR2PresignedUrl({ ...OPTS, key: 'user-1/video-xyz/other.mp4' });
    expect(url1).not.toBe(url2);
  });

  it('encodes slashes in the key as separate path segments (not %2F)', async () => {
    const url = await generateR2PresignedUrl({ ...OPTS, key: 'a/b/c.mp4' });
    // Each segment must be encoded independently, preserving / as a separator.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/spooool-videos/a/b/c.mp4');
  });
});
