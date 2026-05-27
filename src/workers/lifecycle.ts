// /api/lifecycle/sync — fires the welcome email after a successful signup.
// Previously this also synced the user into Loops as a CRM contact; that
// flow was removed when transactional mail moved to Cloudflare Email Service.
// The endpoint is kept (rather than inlined into the signup handler) so the
// frontend continues to fire-and-forget against a stable URL, and so the
// welcome send happens server-side under an authenticated session — not as
// a side effect of better-auth's user-creation hook.

import { Hono } from 'hono';
import { z } from 'zod';
import { sendWelcomeEmail, type EmailEnv } from './email';

export interface LifecycleEnv extends EmailEnv {
  DB: D1Database;
}

interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

type LifecycleVariables = { user: SessionUser | null };

const syncBodySchema = z.object({
  /** When true, fire the welcome email. False / missing → no-op (kept so
      the frontend can call this endpoint idempotently on future profile
      changes without re-mailing the user). */
  isNewSignup: z.boolean().optional().default(false),
}).default({ isNewSignup: false });

export const lifecycleRoutes = new Hono<{
  Bindings: LifecycleEnv;
  Variables: LifecycleVariables;
}>();

lifecycleRoutes.post('/api/lifecycle/sync', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = syncBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const { isNewSignup } = parsed.data;

  if (!isNewSignup) {
    return c.json({ welcome: null });
  }

  const result = await sendWelcomeEmail(c.env, {
    to: user.email,
    firstName: firstWord(user.name),
  });

  if (!result.ok && !result.skipped) {
    console.error(`[lifecycle] welcome email failed for ${user.email}: ${result.message}`);
  }

  // Always 200 — the welcome email is best-effort. Body reports what
  // actually happened so callers can surface a warning if they want.
  return c.json({ welcome: summarise(result) });
});

function firstWord(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [first] = value.trim().split(/\s+/, 1);
  return first || undefined;
}

function summarise(result: Awaited<ReturnType<typeof sendWelcomeEmail>>): {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  messageId?: string;
  message?: string;
} {
  if (result.ok) return { ok: true, skipped: false, messageId: result.messageId };
  if (result.skipped) return { ok: false, skipped: true, reason: result.reason };
  return { ok: false, skipped: false, message: result.message };
}
