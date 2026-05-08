// ALO-160: creator-monetization onboarding endpoints.
//
// Two routes:
//   - POST /api/partners/onboard
//     Idempotent. Creates a Polar Organization for the signed-in user if
//     they don't already have one persisted, then refreshes the local
//     mirror of status + payout capability. Returns the dashboard URL the
//     creator should visit next when re-onboarding is required.
//   - GET /api/partners/me
//     Reads the local mirror only — no Polar round-trip — so the UI can
//     render an onboarding banner cheaply on every page load.
//
// The local user row holds:
//   polar_organization_id   — Polar's UUID, or NULL before onboarding
//   polar_organization_status — mirror of Polar's status enum
//   polar_payouts_enabled   — 0/1 mirror of capabilities.payouts
//   polar_onboarding_started_at — first POST /onboard time (ms)
//   polar_synced_at         — last successful Polar refresh (ms)
//
// `needsReonboarding` (in ./polar) is the canonical predicate; we surface
// the boolean in both responses so the client doesn't reinvent it.

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createOrganization,
  deriveSlug,
  getOrganization,
  type PolarEnv,
  type PolarOrganization,
  type PolarResult,
} from './polar';

export interface PartnersEnv extends PolarEnv {
  DB: D1Database;
  /** Used to build the onboarding redirect URL surfaced to the client. */
  POLAR_DASHBOARD_URL?: string;
}

interface SessionUser {
  id: string;
  email: string;
  name: string;
}

type PartnersVariables = { user: SessionUser | null };

export interface PartnerStateRow {
  polar_organization_id: string | null;
  polar_organization_status: string | null;
  polar_payouts_enabled: number;
  polar_onboarding_started_at: number | null;
  polar_synced_at: number | null;
  username: string | null;
  email: string | null;
  name: string | null;
}

export interface PartnerStateResponse {
  organizationId: string | null;
  status: string | null;
  payoutsEnabled: boolean;
  onboardingStartedAt: number | null;
  syncedAt: number | null;
  needsReonboarding: boolean;
  /** Where the client should send the user to finish onboarding, if any. */
  onboardingUrl: string | null;
}

const DEFAULT_DASHBOARD_URL = 'https://polar.sh/dashboard';

export function buildOnboardingUrl(env: PartnersEnv, slugOrId?: string | null): string {
  const base = env.POLAR_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
  // Polar's dashboard routes are slug-based but `id`-based works too via
  // the redirect they perform. We prefer the slug when we have it.
  if (!slugOrId) return base;
  return `${base.replace(/\/+$/, '')}/${slugOrId}/finance/account`;
}

function rowToResponse(row: PartnerStateRow | null, env: PartnersEnv): PartnerStateResponse {
  const status = row?.polar_organization_status ?? null;
  const payoutsEnabled = !!(row?.polar_payouts_enabled ?? 0);
  const reonboard = !row?.polar_organization_id || status !== 'active' || !payoutsEnabled;
  return {
    organizationId: row?.polar_organization_id ?? null,
    status,
    payoutsEnabled,
    onboardingStartedAt: row?.polar_onboarding_started_at ?? null,
    syncedAt: row?.polar_synced_at ?? null,
    needsReonboarding: reonboard,
    onboardingUrl: reonboard ? buildOnboardingUrl(env, row?.polar_organization_id ?? null) : null,
  };
}

async function loadPartnerRow(env: PartnersEnv, userId: string): Promise<PartnerStateRow | null> {
  return env.DB.prepare(
    `SELECT polar_organization_id, polar_organization_status,
            polar_payouts_enabled, polar_onboarding_started_at,
            polar_synced_at, username, email, name
     FROM user WHERE id = ?`,
  )
    .bind(userId)
    .first<PartnerStateRow>();
}

async function persistFromOrg(
  env: PartnersEnv,
  userId: string,
  org: PolarOrganization,
  startedAt: number | null,
  now: number,
): Promise<void> {
  const onboardingStarted = startedAt ?? now;
  await env.DB.prepare(
    `UPDATE user
     SET polar_organization_id = ?,
         polar_organization_status = ?,
         polar_payouts_enabled = ?,
         polar_onboarding_started_at = COALESCE(polar_onboarding_started_at, ?),
         polar_synced_at = ?,
         updatedAt = ?
     WHERE id = ?`,
  )
    .bind(
      org.id,
      org.status,
      org.capabilities?.payouts ? 1 : 0,
      onboardingStarted,
      now,
      now,
      userId,
    )
    .run();
}

export const partnersRoutes = new Hono<{
  Bindings: PartnersEnv;
  Variables: PartnersVariables;
}>();

partnersRoutes.get('/api/partners/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const row = await loadPartnerRow(c.env, user.id);
  return c.json(rowToResponse(row, c.env));
});

partnersRoutes.post('/api/partners/onboard', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const row = await loadPartnerRow(c.env, user.id);
  const now = Date.now();

  // Already linked: refresh status from Polar so a creator who finished
  // verification since their last visit gets payouts_enabled flipped on
  // without an admin touching the row.
  if (row?.polar_organization_id) {
    const refresh = await getOrganization(c.env, row.polar_organization_id);
    if (refresh.ok) {
      await persistFromOrg(c.env, user.id, refresh.data, row.polar_onboarding_started_at, now);
      const fresh = await loadPartnerRow(c.env, user.id);
      return c.json({
        ...rowToResponse(fresh, c.env),
        synced: true,
      });
    }
    return respondWithSyncFailure(c, refresh, row);
  }

  // First-time onboarding: create the Polar organization. Slug is derived
  // from username (fallback to user id) and is the only required field
  // alongside `name`.
  const slug = deriveSlug({
    username: row?.username ?? null,
    userId: user.id,
  });
  const create = await createOrganization(c.env, {
    name: row?.name ?? user.name ?? slug,
    slug,
    email: row?.email ?? user.email,
  });
  if (create.ok) {
    await persistFromOrg(c.env, user.id, create.data, now, now);
    const fresh = await loadPartnerRow(c.env, user.id);
    return c.json({
      ...rowToResponse(fresh, c.env),
      created: true,
    });
  }
  return respondWithSyncFailure(c, create, row);
});

type PartnersContext = Context<{ Bindings: PartnersEnv; Variables: PartnersVariables }>;

function respondWithSyncFailure(
  c: PartnersContext,
  result: PolarResult<PolarOrganization>,
  row: PartnerStateRow | null,
): Response {
  if (!result.ok && result.skipped) {
    // Polar isn't configured yet — surface a 503 so the client knows the
    // attempt was deferred. The local row is unchanged.
    return c.json(
      {
        ...rowToResponse(row, c.env),
        error: 'partner_onboarding_unavailable',
        reason: result.reason,
      },
      503,
    );
  }
  if (!result.ok && !result.skipped) {
    return c.json(
      {
        ...rowToResponse(row, c.env),
        error: 'partner_onboarding_failed',
        upstreamStatus: result.status,
        message: result.message,
      },
      502,
    );
  }
  return c.json(rowToResponse(row, c.env));
}
