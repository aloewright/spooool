// Thin client for the Resend (resend.com) email API. Replaces the prior
// Loops integration: Resend is a transactional sender, so lifecycle events
// (verification, password reset, welcome) are rendered to inline HTML here
// and sent directly. Contact list management uses Resend Audiences.
//
// Design:
// - All operations fail-open. A missing RESEND_API_KEY (or, for audience
//   ops, RESEND_AUDIENCE_ID) returns a `skipped` result rather than
//   throwing. Lifecycle delivery is best-effort.
// - Pure helpers (buildHeaders, parseResendError, renderLifecycleEmail) are
//   exported for unit tests.

const RESEND_API_BASE = 'https://api.resend.com';
const DEFAULT_FROM = 'spooool <hello@spooool.com>';

export interface ResendEnv {
  /** REST API key from https://resend.com/api-keys . */
  RESEND_API_KEY?: string;
  /** Audience to upsert contacts into (https://resend.com/audiences). */
  RESEND_AUDIENCE_ID?: string;
  /** Default From header. e.g. "spooool <hello@spooool.com>". */
  RESEND_FROM?: string;
}

export interface ResendContact {
  email: string;
  firstName?: string;
  lastName?: string;
  unsubscribed?: boolean;
}

export type ResendResult =
  | { ok: true; status: number }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; status: number; message: string };

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function parseResendError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string; name?: string } | null;
    return body?.message ?? body?.error ?? body?.name ?? `Resend API ${res.status}`;
  } catch {
    return `Resend API ${res.status}`;
  }
}

async function request(
  method: 'POST' | 'PATCH',
  endpoint: string,
  apiKey: string,
  body: unknown,
): Promise<ResendResult> {
  let res: Response;
  try {
    res = await fetch(`${RESEND_API_BASE}${endpoint}`, {
      method,
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.ok) return { ok: true, status: res.status };
  const message = await parseResendError(res);
  return { ok: false, skipped: false, status: res.status, message };
}

// Send a transactional email. The from header falls back to RESEND_FROM and
// then to a sane default; callers shouldn't usually need to pass it.
export async function sendEmail(
  env: ResendEnv,
  args: { to: string; subject: string; html: string; from?: string },
): Promise<ResendResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY not configured' };
  }
  return request('POST', '/emails', env.RESEND_API_KEY, {
    from: args.from ?? env.RESEND_FROM ?? DEFAULT_FROM,
    to: [args.to],
    subject: args.subject,
    html: args.html,
  });
}

// Upsert a contact in the configured audience. Implemented as PATCH-first
// (keyed on email — Resend's contact endpoint accepts either id or email),
// falling back to POST on 404 so signup is idempotent.
export async function upsertContact(
  env: ResendEnv,
  contact: ResendContact,
): Promise<ResendResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY not configured' };
  }
  if (!env.RESEND_AUDIENCE_ID) {
    return { ok: false, skipped: true, reason: 'RESEND_AUDIENCE_ID not configured' };
  }
  const audPath = `/audiences/${env.RESEND_AUDIENCE_ID}/contacts`;
  const body = {
    email: contact.email,
    first_name: contact.firstName,
    last_name: contact.lastName,
    unsubscribed: contact.unsubscribed ?? false,
  };
  const patched = await request(
    'PATCH',
    `${audPath}/${encodeURIComponent(contact.email)}`,
    env.RESEND_API_KEY,
    body,
  );
  if (patched.ok) return patched;
  if (!patched.skipped && patched.status === 404) {
    return request('POST', audPath, env.RESEND_API_KEY, body);
  }
  return patched;
}

// Mark the contact unsubscribed. Used on account deletion. We don't remove
// the contact — Resend keeps the unsubscribed state for compliance.
export async function unsubscribeContact(
  env: ResendEnv,
  email: string,
): Promise<ResendResult> {
  if (!env.RESEND_API_KEY) {
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY not configured' };
  }
  if (!env.RESEND_AUDIENCE_ID) {
    return { ok: false, skipped: true, reason: 'RESEND_AUDIENCE_ID not configured' };
  }
  return request(
    'PATCH',
    `/audiences/${env.RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`,
    env.RESEND_API_KEY,
    { unsubscribed: true },
  );
}

export type LifecycleEmail =
  | { kind: 'email_verification'; verifyUrl: string }
  | { kind: 'password_reset'; resetUrl: string }
  | { kind: 'signup'; firstName?: string };

export function renderLifecycleEmail(msg: LifecycleEmail): { subject: string; html: string } {
  switch (msg.kind) {
    case 'email_verification':
      return {
        subject: 'Verify your spooool email',
        html: `<p>Welcome to spooool!</p>
<p>Confirm your email by clicking the link below:</p>
<p><a href="${escapeHtml(msg.verifyUrl)}">Verify email</a></p>
<p>If you didn't create an account, you can ignore this message.</p>`,
      };
    case 'password_reset':
      return {
        subject: 'Reset your spooool password',
        html: `<p>We got a request to reset your spooool password.</p>
<p><a href="${escapeHtml(msg.resetUrl)}">Reset password</a></p>
<p>If you didn't request a reset, you can ignore this message — your password won't change.</p>`,
      };
    case 'signup': {
      const greeting = msg.firstName ? `Hi ${escapeHtml(msg.firstName)},` : 'Hi,';
      return {
        subject: 'Welcome to spooool',
        html: `<p>${greeting}</p>
<p>Thanks for signing up for spooool. Start by uploading your first video or browsing what's new.</p>
<p>— The spooool team</p>`,
      };
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendLifecycleEmail(
  env: ResendEnv,
  to: string,
  msg: LifecycleEmail,
): Promise<ResendResult> {
  const { subject, html } = renderLifecycleEmail(msg);
  return sendEmail(env, { to, subject, html });
}
