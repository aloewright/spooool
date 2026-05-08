// ALO-160: thin client for the Polar (https://polar.sh) Organizations API.
//
// Polar's "partner / connected account" equivalent is an Organization owned
// by the creator. We create one per spooool creator who opts into
// monetization, persist the returned UUID on the user row, and mirror the
// onboarding status so the app can re-prompt them when KYC / payout
// requirements are still outstanding.
//
// Design mirrors src/workers/resend.ts:
// - Fail-open: a missing POLAR_API_KEY returns `{ skipped: true }` rather
//   than throwing. Onboarding is best-effort while the secret is being
//   provisioned.
// - Pure helpers (`needsReonboarding`, `parsePolarError`) are exported so
//   unit tests can exercise the predicate without a fake fetch.
//
// Production endpoint: https://api.polar.sh/v1
// Sandbox endpoint:    https://sandbox-api.polar.sh/v1

const PROD_BASE = 'https://api.polar.sh/v1';
const SANDBOX_BASE = 'https://sandbox-api.polar.sh/v1';

export interface PolarEnv {
  /** Organization Access Token from Polar dashboard. */
  POLAR_API_KEY?: string;
  /** Set to "sandbox" to route through sandbox-api.polar.sh; defaults to prod. */
  POLAR_ENVIRONMENT?: string;
}

export type PolarStatus =
  | 'created'
  | 'review'
  | 'snoozed'
  | 'denied'
  | 'active'
  | 'blocked'
  | 'offboarding';

export interface PolarOrganization {
  id: string;
  slug: string;
  name: string;
  status: PolarStatus;
  email: string | null;
  details_submitted_at: string | null;
  account_id: string | null;
  payout_account_id: string | null;
  capabilities: {
    checkout_payments?: boolean;
    subscription_renewals?: boolean;
    payouts?: boolean;
    refunds?: boolean;
    api_access?: boolean;
    dashboard_access?: boolean;
  };
}

export type PolarResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; status: number; message: string };

export function polarBaseUrl(env: PolarEnv): string {
  return env.POLAR_ENVIRONMENT === 'sandbox' ? SANDBOX_BASE : PROD_BASE;
}

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function parsePolarError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      detail?: string | Array<{ msg?: string }>;
      error?: string;
      message?: string;
    } | null;
    if (typeof body?.detail === 'string') return body.detail;
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) return body.detail[0].msg;
    return body?.message ?? body?.error ?? `Polar API ${res.status}`;
  } catch {
    return `Polar API ${res.status}`;
  }
}

async function request<T>(
  env: PolarEnv,
  method: 'GET' | 'POST' | 'PATCH',
  endpoint: string,
  body?: unknown,
): Promise<PolarResult<T>> {
  if (!env.POLAR_API_KEY) {
    return { ok: false, skipped: true, reason: 'POLAR_API_KEY not configured' };
  }
  let res: Response;
  try {
    res = await fetch(`${polarBaseUrl(env)}${endpoint}`, {
      method,
      headers: buildHeaders(env.POLAR_API_KEY),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    const message = await parsePolarError(res);
    return { ok: false, skipped: false, status: res.status, message };
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      status: res.status,
      message: err instanceof Error ? err.message : 'Polar response was not JSON',
    };
  }
  return { ok: true, status: res.status, data };
}

// Slug must be 3+ chars, URL-safe. Polar enforces uniqueness so we need to
// be defensive: derive from the username, fall back to the user id, and
// strip anything Polar's regex would reject.
export function deriveSlug(input: { username?: string | null; userId: string }): string {
  const raw = (input.username ?? input.userId).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length >= 3) return cleaned.slice(0, 48);
  // Pad short slugs with a stable suffix from the user id so we don't
  // accidentally collide with the user's username if they later set one.
  const suffix = input.userId
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 8);
  return `${cleaned}${cleaned ? '-' : ''}${suffix || 'creator'}`.slice(0, 48);
}

export interface CreatePartnerInput {
  name: string;
  slug: string;
  email?: string;
}

export function createOrganization(
  env: PolarEnv,
  input: CreatePartnerInput,
): Promise<PolarResult<PolarOrganization>> {
  return request<PolarOrganization>(env, 'POST', '/organizations/', {
    name: input.name,
    slug: input.slug,
    email: input.email,
  });
}

export function getOrganization(
  env: PolarEnv,
  organizationId: string,
): Promise<PolarResult<PolarOrganization>> {
  return request<PolarOrganization>(env, 'GET', `/organizations/${organizationId}`);
}

// Re-onboarding predicate: anything other than an `active` status with
// `payouts` capability flipped on means the creator still has outstanding
// requirements (verification, payout account setup, denial review, etc.)
// and should be routed back to the onboarding flow.
//
// `blocked` and `offboarding` are terminal — payout-disabled, but no
// re-onboarding fix exists; the UI should surface a different state. We
// still return true so the upload / monetization gate stays closed.
export function needsReonboarding(
  org: Pick<PolarOrganization, 'status' | 'capabilities'> | null | undefined,
): boolean {
  if (!org) return true;
  if (org.status !== 'active') return true;
  if (!org.capabilities?.payouts) return true;
  return false;
}
