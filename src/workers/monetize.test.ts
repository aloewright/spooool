import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { monetizeRoutes, type MonetizeEnv } from './monetize';

type SessionUser = { id: string; email: string } | null;

function buildApp(env: MonetizeEnv, user: SessionUser = null) {
  const app = new Hono<{ Bindings: MonetizeEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', monetizeRoutes);
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

// ---------------------------------------------------------------------------
// Fake D1 builder
// ---------------------------------------------------------------------------

interface FakeDBOpts {
  creator?: { id: string; polar_account_status: string } | null;
  video?: { id: string; user_id: string; username: string | null; polar_account_status: string | null } | null;
  tipProduct?: { id: string; polar_product_id: string } | null;
  membershipProduct?: { id: string; polar_product_id: string } | null;
  products?: Array<{
    id: string; kind: string; name: string; description: string | null;
    amount_cents: number | null; currency: string; billing_interval: string | null; active: number;
  }>;
  accountStatus?: string;
  existingTipProduct?: boolean;
  updateChanges?: number;
}

function fakeDB(opts: FakeDBOpts = {}): D1Database {
  const {
    creator = null,
    video = null,
    tipProduct = null,
    membershipProduct = null,
    products = [],
    accountStatus = 'not_connected',
    existingTipProduct = false,
    updateChanges = 1,
  } = opts;

  const insertedProducts: typeof products = [];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first() {
          void bound;
          if (sql.includes('FROM user WHERE username')) return creator;
          if (sql.includes('FROM user WHERE id = ?')) {
            return { polar_account_status: accountStatus };
          }
          if (sql.includes('FROM videos v') && sql.includes('JOIN user u')) return video;
          // tip product lookup during checkout — selects polar_product_id
          if (sql.includes("kind = 'tip'") && sql.includes('polar_product_id') && !sql.includes("kind = 'membership'")) {
            return tipProduct;
          }
          // membership product lookup during checkout — kind='membership' and polar_product_id
          if (sql.includes("kind = 'membership'") && sql.includes('polar_product_id')) {
            return membershipProduct;
          }
          // existing tip product check during link — SELECT id only (no polar_product_id)
          if (sql.includes("kind = 'tip' AND active = 1") && !sql.includes('polar_product_id')) {
            return existingTipProduct ? { id: 'existing-tip-id' } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM channel_products') && sql.includes('user_id')) {
            return { results: [...products, ...insertedProducts] };
          }
          return { results: [] };
        },
        async run() {
          if (/^INSERT INTO channel_products/.test(sql)) {
            const [id, userId, polarProductId, polarPriceId, kind, name, description, amountCents, currency, billingInterval] = bound as string[];
            insertedProducts.push({
              id,
              kind,
              name,
              description: description ?? null,
              amount_cents: amountCents != null ? Number(amountCents) : null,
              currency,
              billing_interval: billingInterval ?? null,
              active: 1,
            });
            void userId; void polarProductId; void polarPriceId;
          }
          if (/^UPDATE channel_products SET active = 0/.test(sql)) {
            return { meta: { changes: updateChanges } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return db;
}

// ---------------------------------------------------------------------------
// GET /api/channels/:username/products
// ---------------------------------------------------------------------------

describe('GET /api/channels/:username/products', () => {
  it('returns 404 when the channel does not exist', async () => {
    const req = buildApp({ DB: fakeDB({ creator: null }) });
    const res = await req('/api/channels/ghost/products');
    expect(res.status).toBe(404);
  });

  it('returns products for an existing channel', async () => {
    const products = [
      { id: 'p1', kind: 'membership', name: 'Fan tier', description: null, amount_cents: 500, currency: 'usd', billing_interval: 'month', active: 1 },
    ];
    const req = buildApp({
      DB: fakeDB({ creator: { id: 'u1', polar_account_status: 'active' }, products }),
    });
    const res = await req('/api/channels/alice/products');
    expect(res.status).toBe(200);
    const body = await res.json() as { products: typeof products };
    expect(body.products).toHaveLength(1);
    expect(body.products[0].name).toBe('Fan tier');
  });
});

// ---------------------------------------------------------------------------
// POST /api/videos/:id/tip
// ---------------------------------------------------------------------------

describe('POST /api/videos/:id/tip', () => {
  it('returns 503 when POLAR_ACCESS_TOKEN is not configured', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500 }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 400 for invalid body', async () => {
    const req = buildApp({ DB: fakeDB(), POLAR_ACCESS_TOKEN: 'tok' });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 50 }), // below $1 minimum
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the video does not exist', async () => {
    const req = buildApp({ DB: fakeDB({ video: null }), POLAR_ACCESS_TOKEN: 'tok' });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500 }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 when the creator has not enabled tipping (inactive status)', async () => {
    const req = buildApp({
      DB: fakeDB({
        video: { id: 'vid1', user_id: 'u1', username: 'alice', polar_account_status: 'pending' },
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500 }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('tipping');
  });

  it('returns 422 when the creator has no tip product configured', async () => {
    const req = buildApp({
      DB: fakeDB({
        video: { id: 'vid1', user_id: 'u1', username: 'alice', polar_account_status: 'active' },
        tipProduct: null,
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500 }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not configured');
  });

  it('returns 502 when Polar checkout API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'error' }));
    const req = buildApp({
      DB: fakeDB({
        video: { id: 'vid1', user_id: 'u1', username: 'alice', polar_account_status: 'active' },
        tipProduct: { id: 'tp1', polar_product_id: 'prod_tip' },
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500 }),
    });
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it('returns checkout_url on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'chk_123', url: 'https://checkout.polar.sh/chk_123' }),
    }));
    const req = buildApp({
      DB: fakeDB({
        video: { id: 'vid1', user_id: 'u1', username: 'alice', polar_account_status: 'active' },
        tipProduct: { id: 'tp1', polar_product_id: 'prod_tip' },
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/videos/vid1/tip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500, message: 'Great video!' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { checkout_url: string };
    expect(body.checkout_url).toBe('https://checkout.polar.sh/chk_123');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// POST /api/channels/:username/membership
// ---------------------------------------------------------------------------

describe('POST /api/channels/:username/membership', () => {
  it('returns 503 when POLAR_ACCESS_TOKEN is not configured', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/channels/alice/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 'p1' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 400 for invalid body', async () => {
    const req = buildApp({ DB: fakeDB(), POLAR_ACCESS_TOKEN: 'tok' });
    const res = await req('/api/channels/alice/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // missing product_id
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the channel does not exist', async () => {
    const req = buildApp({ DB: fakeDB({ creator: null }), POLAR_ACCESS_TOKEN: 'tok' });
    const res = await req('/api/channels/ghost/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 'p1' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 when creator memberships not enabled', async () => {
    const req = buildApp({
      DB: fakeDB({ creator: { id: 'u1', polar_account_status: 'pending' } }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/channels/alice/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 'p1' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the membership product does not belong to the creator', async () => {
    const req = buildApp({
      DB: fakeDB({
        creator: { id: 'u1', polar_account_status: 'active' },
        membershipProduct: null,
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/channels/alice/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 'p-wrong' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns checkout_url on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'chk_456', url: 'https://checkout.polar.sh/chk_456' }),
    }));
    const req = buildApp({
      DB: fakeDB({
        creator: { id: 'u1', polar_account_status: 'active' },
        membershipProduct: { id: 'mem1', polar_product_id: 'prod_mem' },
      }),
      POLAR_ACCESS_TOKEN: 'tok',
    });
    const res = await req('/api/channels/alice/membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: 'mem1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { checkout_url: string };
    expect(body.checkout_url).toBe('https://checkout.polar.sh/chk_456');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// GET /api/account/products
// ---------------------------------------------------------------------------

describe('GET /api/account/products', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/account/products');
    expect(res.status).toBe(401);
  });

  it('returns empty list when creator has no products', async () => {
    const req = buildApp({ DB: fakeDB({ products: [] }) }, { id: 'u1', email: 'a@b.com' });
    const res = await req('/api/account/products');
    expect(res.status).toBe(200);
    const body = await res.json() as { products: unknown[] };
    expect(body.products).toEqual([]);
  });

  it('returns the creator\'s products', async () => {
    const products = [
      { id: 'p1', kind: 'tip', name: 'Tip jar', description: null, amount_cents: null, currency: 'usd', billing_interval: null, active: 1 },
    ];
    const req = buildApp({ DB: fakeDB({ products }) }, { id: 'u1', email: 'a@b.com' });
    const res = await req('/api/account/products');
    expect(res.status).toBe(200);
    const body = await res.json() as { products: typeof products };
    expect(body.products).toHaveLength(1);
    expect(body.products[0].kind).toBe('tip');
  });
});

// ---------------------------------------------------------------------------
// POST /api/account/products
// ---------------------------------------------------------------------------

describe('POST /api/account/products', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tip', name: 'Tips', polar_product_id: 'p1', polar_price_id: 'pr1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 when creator has not completed Polar onboarding', async () => {
    const req = buildApp(
      { DB: fakeDB({ accountStatus: 'pending' }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tip', name: 'Tips', polar_product_id: 'p1', polar_price_id: 'pr1' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Polar payout account');
  });

  it('returns 400 for invalid body', async () => {
    const req = buildApp(
      { DB: fakeDB({ accountStatus: 'active' }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'unknown-type' }), // invalid kind
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when a tip product already exists', async () => {
    const req = buildApp(
      { DB: fakeDB({ accountStatus: 'active', existingTipProduct: true }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tip', name: 'Tip jar', polar_product_id: 'p1', polar_price_id: 'pr1' }),
    });
    expect(res.status).toBe(409);
  });

  it('creates a membership product successfully', async () => {
    const req = buildApp(
      { DB: fakeDB({ accountStatus: 'active', existingTipProduct: false }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'membership',
        name: 'Fan tier',
        polar_product_id: 'prod_mem',
        polar_price_id: 'price_mem',
        amount_cents: 500,
        billing_interval: 'month',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; kind: string; name: string };
    expect(body.kind).toBe('membership');
    expect(body.name).toBe('Fan tier');
    expect(typeof body.id).toBe('string');
  });

  it('creates a tip product successfully when none exists', async () => {
    const req = buildApp(
      { DB: fakeDB({ accountStatus: 'active', existingTipProduct: false }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tip',
        name: 'Tip jar',
        polar_product_id: 'prod_tip',
        polar_price_id: 'price_tip',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('tip');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/account/products/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/account/products/:id', () => {
  it('returns 401 when not signed in', async () => {
    const req = buildApp({ DB: fakeDB() });
    const res = await req('/api/account/products/p1', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the product does not belong to the user', async () => {
    const req = buildApp(
      { DB: fakeDB({ updateChanges: 0 }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products/p-other', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('deactivates a product successfully', async () => {
    const req = buildApp(
      { DB: fakeDB({ updateChanges: 1 }) },
      { id: 'u1', email: 'a@b.com' },
    );
    const res = await req('/api/account/products/p1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
