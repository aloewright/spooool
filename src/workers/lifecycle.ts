// ALO-143: lifecycle endpoints that bridge the app to Loops. The frontend
// calls /api/lifecycle/sync after a successful signup or account-settings
// save so contact data lands in Loops without us needing to monkey-patch
// better-auth's user-creation hooks. The endpoint is idempotent (Loops
// upserts by email), so calling it on every login is also safe — but the
// frontend only fires it on signup + email change.

import { Hono } from 'hono';
import { z } from 'zod';
import { sendEvent, upsertContact, type LoopsEnv } from './loops';

export interface LifecycleEnv extends LoopsEnv {
  DB: D1Database;
}

interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

type LifecycleVariables = { user: SessionUser | null };

const syncBodySchema = z.object({
  /** Optional first-time hint — when true, also fires the welcome event so
      Loops can run the new-account automation. */
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

  const upsertResult = await upsertContact(c.env, {
    email: user.email,
    firstName: firstWord(user.name),
    userId: user.id,
    subscribed: true,
  });

  let eventResult = null;
  if (isNewSignup) {
    eventResult = await sendEvent(c.env, {
      email: user.email,
      eventName: 'signup',
      eventProperties: { userId: user.id },
    });
  }

  // Always 200 — the lifecycle pipeline is best-effort. The body reports
  // what actually happened so callers can surface a warning if they want.
  return c.json({
    contact: summarise(upsertResult),
    event: eventResult ? summarise(eventResult) : null,
  });
});

function firstWord(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [first] = value.trim().split(/\s+/, 1);
  return first || undefined;
}

function summarise(
  result: Awaited<ReturnType<typeof upsertContact>>,
): { ok: boolean; skipped: boolean; reason?: string; status?: number; message?: string } {
  if (result.ok) return { ok: true, skipped: false, status: result.status };
  if (result.skipped) return { ok: false, skipped: true, reason: result.reason };
  return { ok: false, skipped: false, status: result.status, message: result.message };
}
