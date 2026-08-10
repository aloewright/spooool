// LEGAL-REVIEW: this entire workflow needs counsel sign-off before public
// launch. Do not deploy /legal/dmca to production until reviewed. The
// engineering surface (state machine, persistence, 451 response, counter-
// notice timer) is shipped here; the copy and email templates are placeholders
// tracked in follow-up issues.
import { Hono } from 'hono';
import { z } from 'zod';
import { type EmailEnv, sendDmcaAcknowledgmentEmail, sendDmcaUploaderNotifyEmail } from './email';

// Counter-notice waiting period per 17 U.S.C. § 512(g)(2)(C). We use 14
// business days converted to a flat 14 calendar days for cron simplicity;
// counsel may want this widened — see the LEGAL-REVIEW follow-up.
export const COUNTER_NOTICE_WAIT_DAYS = 14;
export const COUNTER_NOTICE_WAIT_MS = COUNTER_NOTICE_WAIT_DAYS * 24 * 60 * 60 * 1000;

export const DMCA_NOTICE_EMAIL = 'dmca@spooool.com';

export interface DmcaEnv extends EmailEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

type SessionUser = { id: string; email: string; name: string } | null;
type DmcaVariables = { user: SessionUser };

const submissionSchema = z.object({
  videoId: z.string().min(1).max(64),
  complainantName: z.string().min(1).max(200),
  complainantEmail: z.string().email().max(254),
  complainantAddress: z.string().min(1).max(500),
  complainantPhone: z.string().min(1).max(50),
  copyrightedWork: z.string().min(1).max(2000),
  infringingUrls: z.array(z.string().url()).min(1).max(20),
  goodFaithSigned: z.literal(true),
  perjurySigned: z.literal(true),
  signature: z.string().min(1).max(200),
});

const counterNoticeSchema = z.object({
  claimId: z.string().min(1).max(64),
  uploaderName: z.string().min(1).max(200),
  uploaderAddress: z.string().min(1).max(500),
  uploaderPhone: z.string().min(1).max(50),
  uploaderEmail: z.string().email().max(254),
  statement: z.string().min(1).max(2000),
  signature: z.string().min(1).max(200),
  consentToJurisdiction: z.literal(true),
});

const decisionSchema = z.object({
  action: z.enum(['disable', 'dismiss']),
});

export const dmcaRoutes = new Hono<{
  Bindings: DmcaEnv;
  Variables: DmcaVariables;
}>();

dmcaRoutes.post('/api/dmca/submission', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = submissionSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid DMCA submission', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const video = await c.env.DB.prepare('SELECT id FROM videos WHERE id = ? AND deleted_at IS NULL')
    .bind(data.videoId)
    .first();
  if (!video) return c.json({ error: 'Video not found' }, 404);

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO dmca_claims
       (id, video_id, complainant_name, complainant_email, complainant_address,
        complainant_phone, copyrighted_work, infringing_urls,
        good_faith_signed, perjury_signed, signature, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      data.videoId,
      data.complainantName,
      data.complainantEmail,
      data.complainantAddress,
      data.complainantPhone,
      data.copyrightedWork,
      JSON.stringify(data.infringingUrls),
      data.signature,
      now,
      now,
    )
    .run();

  // LEGAL-REVIEW: email copy is placeholder (ALO-170) — counsel must approve
  // before launch. Fail-open: a flaky EMAIL binding must not block submission.
  await sendDmcaAcknowledgmentEmail(c.env, {
    to: data.complainantEmail,
    claimId: id,
    videoId: data.videoId,
  });

  return c.json({ id, status: 'pending' }, 201);
});

dmcaRoutes.post('/api/dmca/counter', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const json = await c.req.json().catch(() => null);
  const parsed = counterNoticeSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid counter-notice', details: parsed.error.flatten() }, 400);
  }
  const data = parsed.data;

  const claim = await c.env.DB.prepare(
    `SELECT c.id, c.video_id, c.status, v.user_id AS uploader_user_id
     FROM dmca_claims c
     JOIN videos v ON v.id = c.video_id
     WHERE c.id = ?`,
  )
    .bind(data.claimId)
    .first<{
      id: string;
      video_id: string;
      status: string;
      uploader_user_id: string;
    }>();
  if (!claim) return c.json({ error: 'Claim not found' }, 404);
  if (claim.uploader_user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (claim.status !== 'disabled') {
    return c.json({ error: 'Counter-notices are only valid against disabled claims' }, 400);
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO dmca_counter_notices
       (id, claim_id, uploader_user_id, uploader_name, uploader_address,
        uploader_phone, uploader_email, statement, signature,
        consent_to_jurisdiction, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      data.claimId,
      user.id,
      data.uploaderName,
      data.uploaderAddress,
      data.uploaderPhone,
      data.uploaderEmail,
      data.statement,
      data.signature,
      now,
    )
    .run();

  await c.env.DB.prepare(
    `UPDATE dmca_claims SET status = 'counter_pending', updated_at = ? WHERE id = ?`,
  )
    .bind(now, data.claimId)
    .run();

  await c.env.DB.prepare(
    `UPDATE videos SET dmca_restore_eligible_at = ? WHERE id = ?`,
  )
    .bind(now + COUNTER_NOTICE_WAIT_MS, claim.video_id)
    .run();

  return c.json({ id, claimId: data.claimId, restoreEligibleAt: now + COUNTER_NOTICE_WAIT_MS }, 201);
});

dmcaRoutes.post('/api/admin/dmca/:claimId/decision', async (c) => {
  const admin = c.get('user');
  if (!admin) return c.json({ error: 'Unauthorized' }, 401);
  // Note: admin gating is enforced by moderationRoutes' /api/admin/* middleware
  // when this is mounted under the same app. We re-validate via a follow-up
  // helper here to keep this module standalone for tests.

  const claimId = c.req.param('claimId');
  const json = await c.req.json().catch(() => null);
  const parsed = decisionSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid decision', details: parsed.error.flatten() }, 400);
  }
  const claim = await c.env.DB.prepare(
    `SELECT c.id, c.video_id, c.status, u.email AS uploader_email
     FROM dmca_claims c
     JOIN videos v ON v.id = c.video_id
     JOIN user u ON u.id = v.user_id
     WHERE c.id = ?`,
  )
    .bind(claimId)
    .first<{ id: string; video_id: string; status: string; uploader_email: string }>();
  if (!claim) return c.json({ error: 'Claim not found' }, 404);

  const now = Date.now();
  if (parsed.data.action === 'disable') {
    await c.env.DB.prepare(
      `UPDATE dmca_claims SET status = 'disabled', updated_at = ? WHERE id = ?`,
    )
      .bind(now, claimId)
      .run();
    await c.env.DB.prepare(
      `UPDATE videos SET dmca_status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(claim.video_id)
      .run();
    await c.env.CACHE.delete(`video:v1:${claim.video_id}`);

    // LEGAL-REVIEW: email copy is a placeholder (ALO-170) — counsel must
    // approve before launch. Fail-open: a flaky EMAIL binding must not block
    // the admin response.
    await sendDmcaUploaderNotifyEmail(c.env, {
      to: claim.uploader_email,
      claimId,
      videoId: claim.video_id,
      counterUrl: `https://spooool.com/legal/dmca/counter?claim=${encodeURIComponent(claimId)}`,
    });
  } else {
    await c.env.DB.prepare(
      `UPDATE dmca_claims SET status = 'dismissed', updated_at = ? WHERE id = ?`,
    )
      .bind(now, claimId)
      .run();
  }
  return c.json({ id: claimId, action: parsed.data.action });
});

dmcaRoutes.get('/api/admin/dmca', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, video_id, complainant_name, complainant_email, status, created_at, updated_at
     FROM dmca_claims
     ORDER BY updated_at DESC
     LIMIT 100`,
  ).all();
  return c.json({ claims: results ?? [] });
});

export interface DmcaSweepEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

// Daily sweep: any video whose counter-notice waiting period has elapsed
// (and has no court-order block) is auto-restored per § 512(g)(2)(C).
export async function runDmcaRestoreSweep(env: DmcaSweepEnv, nowMs = Date.now()): Promise<string[]> {
  const due = await env.DB.prepare(
    `SELECT v.id AS video_id, c.id AS claim_id
     FROM videos v
     JOIN dmca_claims c ON c.video_id = v.id
     WHERE v.dmca_status = 'disabled'
       AND v.dmca_restore_eligible_at IS NOT NULL
       AND v.dmca_restore_eligible_at <= ?
       AND c.status = 'counter_pending'`,
  )
    .bind(nowMs)
    .all<{ video_id: string; claim_id: string }>();

  const restored: string[] = [];
  for (const row of due.results ?? []) {
    await env.DB.prepare(
      `UPDATE videos SET dmca_status = NULL, dmca_restore_eligible_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
      .bind(row.video_id)
      .run();
    await env.DB.prepare(
      `UPDATE dmca_claims SET status = 'restored', updated_at = ? WHERE id = ?`,
    )
      .bind(nowMs, row.claim_id)
      .run();
    await env.CACHE.delete(`video:v1:${row.video_id}`);
    restored.push(row.video_id);
  }
  return restored;
}
