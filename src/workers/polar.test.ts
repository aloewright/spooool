import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORM_FEE_BPS,
  parsePlatformFeeBps,
  signWebhookForTest,
  splitFee,
  verifyWebhookSignature,
} from './polar';

const SECRET = 'test-polar-secret';

describe('splitFee', () => {
  it('takes 10% with default bps', () => {
    expect(splitFee(1000, 1000)).toEqual({ gross: 1000, fee: 100, net: 900 });
  });
  it('rounds down on partial cents', () => {
    expect(splitFee(999, 1000)).toEqual({ gross: 999, fee: 99, net: 900 });
  });
  it('clamps a negative gross to 0', () => {
    expect(splitFee(-100, 1000)).toEqual({ gross: 0, fee: 0, net: 0 });
  });
  it('clamps fee bps above 100%', () => {
    expect(splitFee(500, 20_000)).toEqual({ gross: 500, fee: 500, net: 0 });
  });
  it('zero fee yields net == gross', () => {
    expect(splitFee(2500, 0)).toEqual({ gross: 2500, fee: 0, net: 2500 });
  });
});

describe('parsePlatformFeeBps', () => {
  it('returns the default when unset', () => {
    expect(parsePlatformFeeBps({})).toBe(DEFAULT_PLATFORM_FEE_BPS);
  });
  it('parses a numeric string', () => {
    expect(parsePlatformFeeBps({ POLAR_PLATFORM_FEE_BPS: '500' })).toBe(500);
  });
  it('falls back on garbage input', () => {
    expect(parsePlatformFeeBps({ POLAR_PLATFORM_FEE_BPS: 'oops' })).toBe(DEFAULT_PLATFORM_FEE_BPS);
  });
  it('rejects out-of-range values', () => {
    expect(parsePlatformFeeBps({ POLAR_PLATFORM_FEE_BPS: '20000' })).toBe(DEFAULT_PLATFORM_FEE_BPS);
    expect(parsePlatformFeeBps({ POLAR_PLATFORM_FEE_BPS: '-5' })).toBe(DEFAULT_PLATFORM_FEE_BPS);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a fresh, well-signed payload', async () => {
    const body = '{"type":"order.created","data":{"id":"ord_1"}}';
    const id = 'msg_abc';
    const ts = '1700000000';
    const sig = await signWebhookForTest(body, id, ts, SECRET);
    const result = await verifyWebhookSignature(
      body,
      { webhookId: id, webhookTimestamp: ts, webhookSignature: sig },
      SECRET,
      Number(ts),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects when the secret is missing', async () => {
    const result = await verifyWebhookSignature(
      '{}',
      { webhookId: 'a', webhookTimestamp: '1', webhookSignature: 'v1,xx' },
      undefined,
    );
    expect(result).toEqual({ ok: false, reason: 'missing_secret' });
  });

  it('rejects when the webhook-id header is missing', async () => {
    const result = await verifyWebhookSignature(
      '{}',
      { webhookId: null, webhookTimestamp: '1', webhookSignature: 'v1,xx' },
      SECRET,
      1,
    );
    expect(result).toEqual({ ok: false, reason: 'missing_id' });
  });

  it('rejects a stale timestamp', async () => {
    const body = '{}';
    const id = 'msg';
    const ts = '1700000000';
    const sig = await signWebhookForTest(body, id, ts, SECRET);
    const result = await verifyWebhookSignature(
      body,
      { webhookId: id, webhookTimestamp: ts, webhookSignature: sig },
      SECRET,
      Number(ts) + 60 * 60,
    );
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a wrong signature', async () => {
    const body = '{}';
    const id = 'msg';
    const ts = '1700000000';
    const sig = await signWebhookForTest(body, id, ts, 'other-secret');
    const result = await verifyWebhookSignature(
      body,
      { webhookId: id, webhookTimestamp: ts, webhookSignature: sig },
      SECRET,
      Number(ts),
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts the rotation case where one of multiple sigs matches', async () => {
    const body = '{}';
    const id = 'msg';
    const ts = '1700000000';
    const goodSig = await signWebhookForTest(body, id, ts, SECRET);
    const badSig = await signWebhookForTest(body, id, ts, 'other');
    // Header carries multiple space-separated entries.
    const header = `${badSig} ${goodSig}`;
    const result = await verifyWebhookSignature(
      body,
      { webhookId: id, webhookTimestamp: ts, webhookSignature: header },
      SECRET,
      Number(ts),
    );
    expect(result).toEqual({ ok: true });
  });

  it('decodes a whsec_-prefixed base64 secret', async () => {
    // Round-trip: decode -> use, then verify produces the same signature.
    const rawSecret = 'whsec_' + btoa('polar-rotated-secret');
    const body = '{}';
    const id = 'msg';
    const ts = '1700000000';
    const sig = await signWebhookForTest(body, id, ts, rawSecret);
    const result = await verifyWebhookSignature(
      body,
      { webhookId: id, webhookTimestamp: ts, webhookSignature: sig },
      rawSecret,
      Number(ts),
    );
    expect(result).toEqual({ ok: true });
  });
});
