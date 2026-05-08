import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHeaders,
  createOrganization,
  deriveSlug,
  getOrganization,
  needsReonboarding,
  parsePolarError,
  polarBaseUrl,
} from './polar';

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return await impl(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('polarBaseUrl', () => {
  it('defaults to production', () => {
    expect(polarBaseUrl({})).toBe('https://api.polar.sh/v1');
    expect(polarBaseUrl({ POLAR_API_KEY: 'k' })).toBe('https://api.polar.sh/v1');
  });

  it('routes through sandbox when POLAR_ENVIRONMENT=sandbox', () => {
    expect(polarBaseUrl({ POLAR_ENVIRONMENT: 'sandbox' })).toBe('https://sandbox-api.polar.sh/v1');
  });
});

describe('buildHeaders', () => {
  it('sends Bearer auth + JSON content type', () => {
    expect(buildHeaders('polar_oat_xxx')).toEqual({
      Authorization: 'Bearer polar_oat_xxx',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
  });
});

describe('parsePolarError', () => {
  it('returns the FastAPI-style detail string when present', async () => {
    const res = new Response(JSON.stringify({ detail: 'Slug already taken' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parsePolarError(res)).toBe('Slug already taken');
  });

  it('extracts the first msg from a validation error array', async () => {
    const body = { detail: [{ msg: 'name must be at least 3 characters' }] };
    const res = new Response(JSON.stringify(body), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parsePolarError(res)).toBe('name must be at least 3 characters');
  });

  it('falls back to status when body is not JSON', async () => {
    const res = new Response('upstream down', { status: 502 });
    expect(await parsePolarError(res)).toBe('Polar API 502');
  });
});

describe('deriveSlug', () => {
  it('lowercases and uses the username when long enough', () => {
    expect(deriveSlug({ username: 'AlexCreator', userId: 'u1' })).toBe('alexcreator');
  });

  it('rewrites unsupported characters to dashes and strips trailing dashes', () => {
    expect(deriveSlug({ username: 'alex.maker_99!', userId: 'u1' })).toBe('alex-maker-99');
  });

  it('falls back to a user-id-derived slug when username is too short', () => {
    const slug = deriveSlug({ username: 'a', userId: 'cuid_abc1234567' });
    expect(slug.length).toBeGreaterThanOrEqual(3);
    expect(slug).toMatch(/^a-cuidabc1/);
  });

  it('caps slug length at 48 chars', () => {
    const username = 'a'.repeat(80);
    expect(deriveSlug({ username, userId: 'u1' }).length).toBeLessThanOrEqual(48);
  });
});

describe('needsReonboarding', () => {
  it('returns true when there is no organization', () => {
    expect(needsReonboarding(null)).toBe(true);
    expect(needsReonboarding(undefined)).toBe(true);
  });

  it('returns true for non-active statuses', () => {
    for (const status of [
      'created',
      'review',
      'snoozed',
      'denied',
      'blocked',
      'offboarding',
    ] as const) {
      expect(needsReonboarding({ status, capabilities: { payouts: true } })).toBe(true);
    }
  });

  it('returns true when payouts capability is off, even if active', () => {
    expect(needsReonboarding({ status: 'active', capabilities: { payouts: false } })).toBe(true);
  });

  it('returns false only for active + payouts-enabled organizations', () => {
    expect(needsReonboarding({ status: 'active', capabilities: { payouts: true } })).toBe(false);
  });
});

describe('createOrganization', () => {
  it('skips when POLAR_API_KEY is missing', async () => {
    const r = await createOrganization({}, { name: 'Alex', slug: 'alex' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'POLAR_API_KEY not configured' });
  });

  it('POSTs /organizations/ with bearer auth and the prod base URL', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    mockFetch((url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response(
        JSON.stringify({
          id: 'org_123',
          slug: 'alex',
          name: 'Alex',
          status: 'created',
          email: 'alex@x.test',
          details_submitted_at: null,
          account_id: null,
          payout_account_id: null,
          capabilities: { payouts: false },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    const r = await createOrganization(
      { POLAR_API_KEY: 'polar_oat_x' },
      { name: 'Alex', slug: 'alex', email: 'alex@x.test' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.id).toBe('org_123');
      expect(r.data.status).toBe('created');
    }
    expect(seen.url).toBe('https://api.polar.sh/v1/organizations/');
    const headers = (seen.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer polar_oat_x');
    expect(JSON.parse((seen.init?.body as string) ?? '{}')).toEqual({
      name: 'Alex',
      slug: 'alex',
      email: 'alex@x.test',
    });
  });

  it('routes through the sandbox base URL when configured', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return new Response('{}', { status: 201 });
    });
    await createOrganization(
      { POLAR_API_KEY: 'k', POLAR_ENVIRONMENT: 'sandbox' },
      { name: 'Alex', slug: 'alex' },
    );
    expect(url.startsWith('https://sandbox-api.polar.sh/v1')).toBe(true);
  });

  it('reports the API error message when Polar returns non-2xx', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ detail: 'Slug already taken' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await createOrganization({ POLAR_API_KEY: 'k' }, { name: 'a', slug: 'taken' });
    expect(r).toEqual({ ok: false, skipped: false, status: 422, message: 'Slug already taken' });
  });

  it('catches network errors without throwing', async () => {
    mockFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const r = await createOrganization({ POLAR_API_KEY: 'k' }, { name: 'a', slug: 'b' });
    expect(r).toMatchObject({ ok: false, skipped: false, status: 0 });
    if (!r.ok && !r.skipped) {
      expect(r.message).toContain('connect ECONNREFUSED');
    }
  });
});

describe('getOrganization', () => {
  it('GETs /organizations/:id', async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(
        JSON.stringify({
          id: 'org_123',
          slug: 'alex',
          name: 'Alex',
          status: 'active',
          email: 'alex@x.test',
          details_submitted_at: '2025-01-01T00:00:00Z',
          account_id: 'acct_1',
          payout_account_id: 'acct_1',
          capabilities: { payouts: true, dashboard_access: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const r = await getOrganization({ POLAR_API_KEY: 'k' }, 'org_123');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe('active');
      expect(r.data.capabilities.payouts).toBe(true);
    }
    expect(calls).toEqual(['GET https://api.polar.sh/v1/organizations/org_123']);
  });
});
