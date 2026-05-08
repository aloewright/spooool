import { describe, expect, it } from 'vitest';
import { fetchPolarSummary, type PayoutsEnv } from './payouts';

function envWith(token?: string): PayoutsEnv {
  return { DB: {} as D1Database, POLAR_API_TOKEN: token };
}

describe('fetchPolarSummary', () => {
  it('returns null when no token is configured', async () => {
    const result = await fetchPolarSummary(envWith(undefined), 'user_1', () => {
      throw new Error('fetch should not be called');
    });
    expect(result).toBeNull();
  });

  it('parses a successful balance response', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          balance: { amount: 12345, currency: 'USD' },
          last_payout_at: '2025-01-02T03:04:05Z',
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const summary = await fetchPolarSummary(envWith('tok'), 'user_1', fakeFetch);
    expect(summary?.balanceCents).toBe(12345);
    expect(summary?.currency).toBe('USD');
    expect(summary?.lastPayoutAt).toBe(Date.parse('2025-01-02T03:04:05Z'));
  });

  it('returns null on non-2xx', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const summary = await fetchPolarSummary(envWith('tok'), 'user_1', fakeFetch);
    expect(summary).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fakeFetch = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const summary = await fetchPolarSummary(envWith('tok'), 'user_1', fakeFetch);
    expect(summary).toBeNull();
  });
});
