import { Hono } from 'hono';
import { z } from 'zod';
import { type EmailEnv, send } from './email';

export interface ContactEnv extends EmailEnv {
  DB: D1Database;
}

const SUPPORT_EMAIL = 'support@spooool.com';

const VALID_CATEGORIES = ['general', 'upload', 'account', 'dmca', 'other'] as const;

const contactSchema = z.object({
  email:    z.string().email().max(254),
  category: z.enum(VALID_CATEGORIES).default('general'),
  message:  z.string().min(10).max(4000),
});

export const contactRoutes = new Hono<{ Bindings: ContactEnv }>();

contactRoutes.post('/api/contact', async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = contactSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { email, category, message } = parsed.data;
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    `INSERT INTO contact_messages (id, email, category, message) VALUES (?, ?, ?, ?)`,
  ).bind(id, email.toLowerCase().trim(), category, message).run();

  // Forward to the support inbox. Fail-open — a flaky email send must not
  // block the 200 response the user sees.
  void send(c.env, {
    to: SUPPORT_EMAIL,
    from: { email: SUPPORT_EMAIL, name: 'spooool Support' },
    replyTo: { email },
    subject: `[Support] ${category} — ${email}`,
    text: `From: ${email}\nCategory: ${category}\n\n${message}`,
    html: `<p><strong>From:</strong> ${email}<br><strong>Category:</strong> ${category}</p><hr><p>${message.replace(/\n/g, '<br>')}</p>`,
  }).catch((err: unknown) => {
    console.error('[contact] email forward failed', { error: String(err) });
  });

  return c.json({ ok: true });
});
