// ALO-127: public waitlist for the E8 launch.
//
// POST /api/waitlist — anyone can submit an email. We:
//   1. Validate + normalize.
//   2. INSERT OR IGNORE into the waitlist table (idempotent).
//   3. Best-effort upsert into the Resend audience so the email lands in our
//      lifecycle list. A missing RESEND_AUDIENCE_ID just skips this step.
//
// The endpoint is rate-limited per-IP via the existing token-bucket DO so a
// drive-by script can't fill the table.
//
// GET /api/waitlist/count — public count for the marketing site (no PII).

import { Hono } from 'hono';
import { z } from 'zod';
import { upsertContact, type ResendEnv } from './resend';
import {
  WAITLIST_BUCKET,
  clientIp,
  rateLimit,
  rateLimitHeaders,
} from './rate-limit';

export interface WaitlistEnv extends ResendEnv {
  DB: D1Database;
  RATE_LIMITER?: DurableObjectNamespace;
}

const submissionSchema = z.object({
  email: z.string().email().max(254),
  source: z.string().min(1).max(64).optional(),
  referrer: z.string().max(500).optional(),
});

export const waitlistRoutes = new Hono<{ Bindings: WaitlistEnv }>();

waitlistRoutes.post('/api/waitlist', async (c) => {
  const ip = clientIp(c.req.raw);
  const rl = await rateLimit({
    ns: c.env.RATE_LIMITER,
    bucket: WAITLIST_BUCKET,
    identity: ip,
  });
  if (!rl.allowed) {
    return c.json(
      { error: 'Too many waitlist signups. Try again shortly.' },
      429,
      rateLimitHeaders(rl),
    );
  }

  const json = await c.req.json().catch(() => null);
  const parsed = submissionSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid waitlist submission', details: parsed.error.flatten() }, 400);
  }
  const email = parsed.data.email.trim().toLowerCase();
  const source = parsed.data.source?.trim() || 'web';
  const referrer = parsed.data.referrer?.trim() || null;

  const id = crypto.randomUUID();
  const now = Date.now();

  // INSERT OR IGNORE — duplicate emails are a no-op so users can re-submit
  // without seeing an error.
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO waitlist (id, email, source, referrer, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, email, source, referrer, now)
    .run();

  // Best-effort Resend audience sync. Failures are silently ignored — the
  // email is already in D1 and we can replay later.
  let synced = false;
  if (c.env.RESEND_API_KEY && c.env.RESEND_AUDIENCE_ID) {
    const result = await upsertContact(c.env, { email });
    synced = result.ok;
  }

  return c.json({ ok: true, synced }, 201);
});

waitlistRoutes.get('/api/waitlist/count', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM waitlist')
    .first<{ count: number }>();
  return c.json({ count: row?.count ?? 0 });
});
