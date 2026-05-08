import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  buildOnboardingUrl,
  partnersRoutes,
  type PartnersEnv,
  type PartnerStateResponse,
} from './partners';

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

interface FakeUserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  polar_organization_id: string | null;
  polar_organization_status: string | null;
  polar_payouts_enabled: number;
  polar_onboarding_started_at: number | null;
  polar_synced_at: number | null;
}

function seedUser(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: 'u1',
    email: 'alex@x.test',
    name: 'Alex',
    username: 'alex',
    polar_organization_id: null,
    polar_organization_status: null,
    polar_payouts_enabled: 0,
    polar_onboarding_started_at: null,
    polar_synced_at: null,
    ...overrides,
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(user: FakeUserRow): D1Database {
  const stmt = (sql: string): PreparedStmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: PreparedStmt = {
      bind(...v: unknown[]) {
        bound = v;
        return api;
      },
      async first<T>() {
        if (
          trimmed.startsWith(
            'SELECT polar_organization_id, polar_organization_status, polar_payouts_enabled',
          )
        ) {
          if (bound[0] !== user.id) return null;
          return user as unknown as T;
        }
        return null;
      },
      async run() {
        if (
          trimmed.startsWith(
            'UPDATE user SET polar_organization_id = ?, polar_organization_status = ?, polar_payouts_enabled = ?',
          )
        ) {
          user.polar_organization_id = bound[0] as string;
          user.polar_organization_status = bound[1] as string;
          user.polar_payouts_enabled = bound[2] as number;
          // COALESCE(existing, ?) — preserve previous if present
          user.polar_onboarding_started_at =
            user.polar_onboarding_started_at ?? (bound[3] as number);
          user.polar_synced_at = bound[4] as number;
        }
        return { success: true };
      },
    };
    return api;
  };
  return { prepare: stmt } as unknown as D1Database;
}

type PartnersCtx = {
  Bindings: PartnersEnv;
  Variables: { user: { id: string; email: string; name: string } | null };
};

function makeApp(user: FakeUserRow, asUser: { id: string } | null, env: Partial<PartnersEnv> = {}) {
  const app = new Hono<PartnersCtx>();
  app.use('*', async (c, next) => {
    if (asUser) {
      c.set('user', { id: user.id, email: user.email, name: user.name });
    } else {
      c.set('user', null);
    }
    await next();
  });
  app.route('/', partnersRoutes);
  const fullEnv: PartnersEnv = {
    DB: fakeDB(user),
    ...env,
  };
  return {
    async post(path: string, body?: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }),
        fullEnv as never,
      );
    },
    async get(path: string) {
      return app.fetch(new Request(`http://t${path}`), fullEnv as never);
    },
  };
}

describe('buildOnboardingUrl', () => {
  it('uses POLAR_DASHBOARD_URL when set', () => {
    const env: PartnersEnv = { DB: {} as D1Database, POLAR_DASHBOARD_URL: 'https://x/y/' };
    expect(buildOnboardingUrl(env, 'org_1')).toBe('https://x/y/org_1/finance/account');
  });

  it('falls back to https://polar.sh/dashboard', () => {
    const env: PartnersEnv = { DB: {} as D1Database };
    expect(buildOnboardingUrl(env, 'org_1')).toBe(
      'https://polar.sh/dashboard/org_1/finance/account',
    );
  });

  it('returns the bare dashboard URL when org id is missing', () => {
    const env: PartnersEnv = { DB: {} as D1Database };
    expect(buildOnboardingUrl(env, null)).toBe('https://polar.sh/dashboard');
  });
});

describe('GET /api/partners/me', () => {
  it('returns 401 when unauthenticated', async () => {
    const user = seedUser();
    const app = makeApp(user, null);
    const res = await app.get('/api/partners/me');
    expect(res.status).toBe(401);
  });

  it('returns needsReonboarding=true when no organization is linked yet', async () => {
    const user = seedUser();
    const app = makeApp(user, { id: 'u1' });
    const res = await app.get('/api/partners/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PartnerStateResponse;
    expect(body.organizationId).toBeNull();
    expect(body.payoutsEnabled).toBe(false);
    expect(body.needsReonboarding).toBe(true);
    expect(body.onboardingUrl).toBe('https://polar.sh/dashboard');
  });

  it('returns needsReonboarding=false when partner is fully active', async () => {
    const user = seedUser({
      polar_organization_id: 'org_active',
      polar_organization_status: 'active',
      polar_payouts_enabled: 1,
      polar_onboarding_started_at: 1700000000000,
      polar_synced_at: 1700000001000,
    });
    const app = makeApp(user, { id: 'u1' });
    const res = await app.get('/api/partners/me');
    const body = (await res.json()) as PartnerStateResponse;
    expect(body.organizationId).toBe('org_active');
    expect(body.payoutsEnabled).toBe(true);
    expect(body.needsReonboarding).toBe(false);
    expect(body.onboardingUrl).toBeNull();
  });

  it('returns needsReonboarding=true when the partner has payouts disabled', async () => {
    const user = seedUser({
      polar_organization_id: 'org_review',
      polar_organization_status: 'review',
      polar_payouts_enabled: 0,
    });
    const app = makeApp(user, { id: 'u1' });
    const res = await app.get('/api/partners/me');
    const body = (await res.json()) as PartnerStateResponse;
    expect(body.needsReonboarding).toBe(true);
    expect(body.onboardingUrl).toContain('org_review');
  });
});

describe('POST /api/partners/onboard', () => {
  it('returns 401 when unauthenticated', async () => {
    const user = seedUser();
    const app = makeApp(user, null);
    const res = await app.post('/api/partners/onboard');
    expect(res.status).toBe(401);
  });

  it('creates a Polar organization on first onboard and persists the id + status', async () => {
    const user = seedUser();
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    mockFetch((url, init) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return new Response(
        JSON.stringify({
          id: 'org_new',
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
    const app = makeApp(user, { id: 'u1' }, { POLAR_API_KEY: 'polar_oat_x' });
    const res = await app.post('/api/partners/onboard');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PartnerStateResponse & { created?: boolean };
    expect(body.created).toBe(true);
    expect(body.organizationId).toBe('org_new');
    expect(body.status).toBe('created');
    // Newly-created orgs are not yet payout-eligible — re-onboarding still required.
    expect(body.payoutsEnabled).toBe(false);
    expect(body.needsReonboarding).toBe(true);
    expect(body.onboardingUrl).toContain('org_new');

    expect(user.polar_organization_id).toBe('org_new');
    expect(user.polar_organization_status).toBe('created');
    expect(user.polar_payouts_enabled).toBe(0);
    expect(user.polar_onboarding_started_at).toBeGreaterThan(0);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('https://api.polar.sh/v1/organizations/');
    expect(requests[0].body).toEqual({ name: 'Alex', slug: 'alex', email: 'alex@x.test' });
  });

  it('refreshes status from Polar when an organization is already linked', async () => {
    const user = seedUser({
      polar_organization_id: 'org_existing',
      polar_organization_status: 'review',
      polar_payouts_enabled: 0,
      polar_onboarding_started_at: 1700000000000,
    });
    const requests: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      requests.push({ url, method: init?.method ?? 'GET' });
      return new Response(
        JSON.stringify({
          id: 'org_existing',
          slug: 'alex',
          name: 'Alex',
          status: 'active',
          email: 'alex@x.test',
          details_submitted_at: '2025-01-01T00:00:00Z',
          account_id: 'acct_1',
          payout_account_id: 'acct_1',
          capabilities: { payouts: true },
        }),
        { status: 200 },
      );
    });
    const app = makeApp(user, { id: 'u1' }, { POLAR_API_KEY: 'k' });
    const res = await app.post('/api/partners/onboard');
    expect(res.status).toBe(200);
    const body = (await res.json()) as PartnerStateResponse & { synced?: boolean };
    expect(body.synced).toBe(true);
    expect(body.status).toBe('active');
    expect(body.payoutsEnabled).toBe(true);
    expect(body.needsReonboarding).toBe(false);
    expect(body.onboardingUrl).toBeNull();
    // Started-at preserved across syncs.
    expect(user.polar_onboarding_started_at).toBe(1700000000000);
    expect(requests).toEqual([
      { method: 'GET', url: 'https://api.polar.sh/v1/organizations/org_existing' },
    ]);
  });

  it('returns 503 with the unchanged local state when POLAR_API_KEY is missing', async () => {
    const user = seedUser();
    const app = makeApp(user, { id: 'u1' });
    const res = await app.post('/api/partners/onboard');
    expect(res.status).toBe(503);
    const body = (await res.json()) as PartnerStateResponse & { error: string };
    expect(body.error).toBe('partner_onboarding_unavailable');
    expect(user.polar_organization_id).toBeNull();
  });

  it('returns 502 when Polar rejects the create call', async () => {
    const user = seedUser();
    mockFetch(
      () =>
        new Response(JSON.stringify({ detail: 'Slug already taken' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const app = makeApp(user, { id: 'u1' }, { POLAR_API_KEY: 'k' });
    const res = await app.post('/api/partners/onboard');
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string; upstreamStatus: number };
    expect(body.error).toBe('partner_onboarding_failed');
    expect(body.upstreamStatus).toBe(422);
    expect(body.message).toBe('Slug already taken');
    expect(user.polar_organization_id).toBeNull();
  });
});
