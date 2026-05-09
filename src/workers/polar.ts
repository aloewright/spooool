// ALO-125: thin client for the Polar (polar.sh) REST API + Standard
// Webhooks signature verification.
//
// Polar is the Merchant of Record for spooool: it collects/remits sales
// tax, runs Checkout, and handles partner payouts to creators. We never
// store card details or PII beyond what Polar gives us back via webhooks.
//
// Design:
// - Client requests fail-loud: missing POLAR_ACCESS_TOKEN throws so an
//   onboarding/checkout call never silently no-ops.
// - Webhook signature follows the Standard Webhooks spec
//   (https://github.com/standard-webhooks/standard-webhooks). The raw
//   secret may be either base64 (`whsec_<base64>`) or a plain string —
//   the verifier handles both.
// - All amount fields use integer cents. Polar's API returns amounts in
//   cents/smallest currency unit; we keep that representation end-to-end.

const POLAR_API_BASE = 'https://api.polar.sh';

export const POLAR_WEBHOOK_TOLERANCE_SECONDS = 60 * 5;

export interface PolarEnv {
  /** Personal/organization access token from polar.sh dashboard. */
  POLAR_ACCESS_TOKEN?: string;
  /** Polar organization id used as parent for created products / partners. */
  POLAR_ORGANIZATION_ID?: string;
  /** Webhook signing secret. May start with `whsec_` (base64) or be plain. */
  POLAR_WEBHOOK_SECRET?: string;
  /** Spooool's revenue share, in basis points. e.g. 1000 = 10%. */
  POLAR_PLATFORM_FEE_BPS?: string;
  /** Public origin used for Polar return / cancel URLs. */
  PUBLIC_ORIGIN?: string;
}

export interface PolarCheckoutInput {
  productPriceId: string;
  customerEmail?: string;
  successUrl: string;
  metadata?: Record<string, string>;
}

export interface PolarCheckoutResponse {
  id: string;
  url: string;
}

export interface PolarProductInput {
  organizationId: string;
  name: string;
  description?: string;
  priceAmountCents: number;
  priceCurrency: string;
  recurringInterval?: 'month' | 'year';
}

export interface PolarProductResponse {
  id: string;
  /** First price id; for one-time products there's exactly one. */
  priceId: string;
}

export interface PolarPartnerLink {
  /** Polar account id. */
  accountId: string;
  /** Hosted onboarding URL the creator visits to complete KYC. */
  onboardingUrl: string;
}

function requireToken(env: PolarEnv): string {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new Error('POLAR_ACCESS_TOKEN not configured');
  }
  return env.POLAR_ACCESS_TOKEN;
}

async function polarFetch(
  env: PolarEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = requireToken(env);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${POLAR_API_BASE}${path}`, { ...init, headers });
}

async function expectJson<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Polar ${action} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// Create a recurring product + price under the org. Used to back
// channel membership tiers.
export async function createRecurringProduct(
  env: PolarEnv,
  input: PolarProductInput,
): Promise<PolarProductResponse> {
  const interval = input.recurringInterval ?? 'month';
  const res = await polarFetch(env, '/v1/products', {
    method: 'POST',
    body: JSON.stringify({
      organization_id: input.organizationId,
      name: input.name,
      description: input.description ?? '',
      recurring_interval: interval,
      prices: [
        {
          amount_type: 'fixed',
          price_amount: input.priceAmountCents,
          price_currency: input.priceCurrency.toLowerCase(),
          recurring_interval: interval,
        },
      ],
    }),
  });
  type CreateProductResp = {
    id: string;
    prices?: { id: string }[];
  };
  const body = await expectJson<CreateProductResp>(res, 'createRecurringProduct');
  const priceId = body.prices?.[0]?.id;
  if (!priceId) {
    throw new Error('Polar createRecurringProduct returned no price id');
  }
  return { id: body.id, priceId };
}

// Create a one-time fixed-price product. Used for per-video tipping.
export async function createOneTimeProduct(
  env: PolarEnv,
  input: PolarProductInput,
): Promise<PolarProductResponse> {
  const res = await polarFetch(env, '/v1/products', {
    method: 'POST',
    body: JSON.stringify({
      organization_id: input.organizationId,
      name: input.name,
      description: input.description ?? '',
      prices: [
        {
          amount_type: 'fixed',
          price_amount: input.priceAmountCents,
          price_currency: input.priceCurrency.toLowerCase(),
        },
      ],
    }),
  });
  type CreateProductResp = {
    id: string;
    prices?: { id: string }[];
  };
  const body = await expectJson<CreateProductResp>(res, 'createOneTimeProduct');
  const priceId = body.prices?.[0]?.id;
  if (!priceId) {
    throw new Error('Polar createOneTimeProduct returned no price id');
  }
  return { id: body.id, priceId };
}

// Create a hosted Checkout session.
export async function createCheckout(
  env: PolarEnv,
  input: PolarCheckoutInput,
): Promise<PolarCheckoutResponse> {
  const res = await polarFetch(env, '/v1/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      product_price_id: input.productPriceId,
      customer_email: input.customerEmail,
      success_url: input.successUrl,
      metadata: input.metadata ?? {},
    }),
  });
  type CheckoutResp = { id: string; url: string };
  const body = await expectJson<CheckoutResp>(res, 'createCheckout');
  return { id: body.id, url: body.url };
}

// Create or fetch a Polar partner/connected account for a creator and
// generate a hosted onboarding link. The Polar partner program is the
// recommended way to pay creators directly — it bypasses Stripe Connect
// entirely.
export async function createPartnerAccount(
  env: PolarEnv,
  args: { email: string; name: string; metadata?: Record<string, string> },
): Promise<PolarPartnerLink> {
  const res = await polarFetch(env, '/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({
      account_type: 'partner',
      email: args.email,
      name: args.name,
      metadata: args.metadata ?? {},
    }),
  });
  type AccountResp = { id: string; onboarding_url?: string; url?: string };
  const body = await expectJson<AccountResp>(res, 'createPartnerAccount');
  const onboardingUrl = body.onboarding_url ?? body.url;
  if (!onboardingUrl) {
    throw new Error('Polar createPartnerAccount returned no onboarding url');
  }
  return { accountId: body.id, onboardingUrl };
}

// ---- Webhook signature verification (Standard Webhooks spec) ----------

export type WebhookVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing_secret'
        | 'missing_id'
        | 'missing_timestamp'
        | 'missing_signature'
        | 'malformed_signature'
        | 'stale_timestamp'
        | 'bad_signature';
    };

export interface PolarWebhookHeaders {
  webhookId: string | null | undefined;
  webhookTimestamp: string | null | undefined;
  webhookSignature: string | null | undefined;
}

function decodeSecret(secret: string): Uint8Array {
  // Standard Webhooks recommends `whsec_<base64>` but plenty of providers
  // (including Polar's older docs) hand back a raw token. Try base64 if
  // prefixed; otherwise treat as a UTF-8 byte sequence.
  if (secret.startsWith('whsec_')) {
    const b64 = secret.slice('whsec_'.length);
    return base64ToBytes(b64);
  }
  return new TextEncoder().encode(secret);
}

function base64ToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signWebhookForTest(
  rawBody: string,
  webhookId: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const keyBytes = decodeSecret(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = new TextEncoder().encode(`${webhookId}.${timestamp}.${rawBody}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `v1,${bytesToBase64(new Uint8Array(sig))}`;
}

export async function verifyWebhookSignature(
  rawBody: string,
  headers: PolarWebhookHeaders,
  secret: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<WebhookVerification> {
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!headers.webhookId) return { ok: false, reason: 'missing_id' };
  if (!headers.webhookTimestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!headers.webhookSignature) return { ok: false, reason: 'missing_signature' };

  const ts = Number(headers.webhookTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_signature' };
  if (Math.abs(now - ts) > POLAR_WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  // Header may carry multiple space-separated `v1,<base64>` entries.
  // Any matching one wins (rotation tolerance).
  const candidates = headers.webhookSignature
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (candidates.length === 0) return { ok: false, reason: 'malformed_signature' };

  const keyBytes = decodeSecret(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = new TextEncoder().encode(
    `${headers.webhookId}.${headers.webhookTimestamp}.${rawBody}`,
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));

  for (const entry of candidates) {
    const comma = entry.indexOf(',');
    if (comma <= 0) continue;
    const version = entry.slice(0, comma);
    if (version !== 'v1') continue;
    const provided = entry.slice(comma + 1);
    let providedBytes: Uint8Array;
    try {
      providedBytes = base64ToBytes(provided);
    } catch {
      continue;
    }
    if (timingSafeEqual(expected, providedBytes)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

// ---- Fee math ---------------------------------------------------------

export const DEFAULT_PLATFORM_FEE_BPS = 1000; // 10%

export function parsePlatformFeeBps(env: PolarEnv): number {
  const raw = env.POLAR_PLATFORM_FEE_BPS;
  if (!raw) return DEFAULT_PLATFORM_FEE_BPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return DEFAULT_PLATFORM_FEE_BPS;
  return Math.floor(n);
}

export function splitFee(
  grossCents: number,
  feeBps: number,
): { gross: number; fee: number; net: number } {
  const gross = Math.max(0, Math.floor(grossCents));
  const bps = Math.max(0, Math.min(10_000, Math.floor(feeBps)));
  const fee = Math.floor((gross * bps) / 10_000);
  return { gross, fee, net: gross - fee };
}
