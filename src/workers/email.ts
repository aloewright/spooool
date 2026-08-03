// Thin client for Cloudflare Email Service's `send_email` Worker binding.
// Replaces the previous Loops integration (ALO-143) — all transactional
// auth mail is now sent directly from the Worker via env.EMAIL.send().
//
// Design mirrors the old loops.ts: every operation is fail-open and returns
// a result object describing what happened. A flaky email upstream must
// never take down the calling request path (signup, password reset, etc.).
// Callers branch on result.skipped / result.ok and log; better-auth will
// resolve its callback either way.
//
// Domain onboarding: the `from` domain must be enabled for Email Sending
// before the first send. Run `wrangler email sending enable spooool.com`
// once and ensure SPF / DKIM / DMARC records are in place. See the
// cloudflare-email-service skill (references/deliverability.md) for the
// full checklist.

/**
 * Cloudflare Email Sending binding shape. Declared inline so we don't need
 * a workers-types upgrade just for this. Matches the runtime API documented
 * at https://developers.cloudflare.com/email-service/email-sending/ .
 */
export interface EmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: { email: string; name?: string };
  }): Promise<{ messageId?: string }>;
}

export interface EmailEnv {
  /** Bound via `send_email` in wrangler.toml. Absent in unit tests. */
  EMAIL?: EmailBinding;
  /** Verified sender address (defaults to noreply@spooool.com). */
  EMAIL_FROM?: string;
  /** Human-readable sender name shown in mail clients. */
  EMAIL_FROM_NAME?: string;
}

export type EmailResult =
  | { ok: true; messageId?: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; message: string };

const DEFAULT_FROM_EMAIL = 'noreply@spooool.com';
const DEFAULT_FROM_NAME = 'Spooool';

function fromAddress(env: EmailEnv): { email: string; name?: string } {
  return {
    email: env.EMAIL_FROM ?? DEFAULT_FROM_EMAIL,
    name: env.EMAIL_FROM_NAME ?? DEFAULT_FROM_NAME,
  };
}

export async function send(
  env: EmailEnv,
  message: {
    to: string;
    subject: string;
    html: string;
    text: string;
  },
): Promise<EmailResult> {
  if (!env.EMAIL) {
    return { ok: false, skipped: true, reason: 'EMAIL binding not configured' };
  }
  try {
    const res = await env.EMAIL.send({
      to: message.to,
      from: fromAddress(env),
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return { ok: true, messageId: res?.messageId };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Plain-text fallback gets included on every send — some clients refuse to
// render HTML, and missing a text/plain part tanks spam scores.
export function buildPasswordResetEmail(url: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Reset your Spooool password',
    text:
      `We received a request to reset your Spooool password.\n\n` +
      `Open this link to choose a new one (valid for 1 hour):\n${url}\n\n` +
      `If you didn't ask to reset your password, you can ignore this email.`,
    html:
      `<p>We received a request to reset your Spooool password.</p>` +
      `<p><a href="${url}">Reset your password</a> (link valid for 1 hour).</p>` +
      `<p>If you didn't ask to reset your password, you can ignore this email.</p>`,
  };
}

export function buildVerificationEmail(url: string): { subject: string; html: string; text: string } {
  return {
    subject: 'Verify your Spooool email',
    text:
      `Welcome to Spooool! Please confirm your email address by opening this link:\n${url}\n\n` +
      `If you didn't create a Spooool account, you can ignore this email.`,
    html:
      `<p>Welcome to Spooool! Please confirm your email address.</p>` +
      `<p><a href="${url}">Verify your email</a></p>` +
      `<p>If you didn't create a Spooool account, you can ignore this email.</p>`,
  };
}

export function buildPasswordResetConfirmationEmail(): { subject: string; html: string; text: string } {
  return {
    subject: 'Your Spooool password was changed',
    text:
      `Your Spooool password was just changed.\n\n` +
      `If this wasn't you, reset your password immediately and contact support.`,
    html:
      `<p>Your Spooool password was just changed.</p>` +
      `<p>If this wasn't you, reset your password immediately and contact support.</p>`,
  };
}

export function buildWelcomeEmail(firstName?: string): { subject: string; html: string; text: string } {
  const greet = firstName ? `Hey ${firstName},` : 'Hey there,';
  return {
    subject: 'Welcome to Spooool',
    text:
      `${greet}\n\n` +
      `Thanks for signing up for Spooool — a video host that respects your time.\n\n` +
      `Upload your first video, follow a few channels, and you're set.`,
    html:
      `<p>${greet}</p>` +
      `<p>Thanks for signing up for Spooool — a video host that respects your time.</p>` +
      `<p>Upload your first video, follow a few channels, and you're set.</p>`,
  };
}

export async function sendPasswordResetEmail(
  env: EmailEnv,
  args: { to: string; url: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildPasswordResetEmail(args.url) });
}

export async function sendVerificationEmail(
  env: EmailEnv,
  args: { to: string; url: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildVerificationEmail(args.url) });
}

export async function sendPasswordResetConfirmationEmail(
  env: EmailEnv,
  args: { to: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildPasswordResetConfirmationEmail() });
}

export async function sendWelcomeEmail(
  env: EmailEnv,
  args: { to: string; firstName?: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildWelcomeEmail(args.firstName) });
}

export function buildCostAlertEmail(
  props: Record<string, string | number>,
): { subject: string; html: string; text: string } {
  const lines = Object.entries(props).map(([k, v]) => `${k}: ${v}`);
  const htmlRows = Object.entries(props)
    .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');
  return {
    subject: `[Spooool] Cost alert: ${props.alert_reasons ?? 'threshold tripped'}`,
    text:
      `A Spooool cost threshold has been tripped.\n\n${lines.join('\n')}\n\n` +
      `Check the admin dashboard for the live cost snapshot.`,
    html:
      `<p>A Spooool cost threshold has been tripped.</p>` +
      `<table>${htmlRows}</table>` +
      `<p>Check the admin dashboard for the live cost snapshot.</p>`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildWaitlistInviteEmail(args: {
  name: string | null;
  signupUrl: string;
}): { subject: string; html: string; text: string } {
  const { name, signupUrl } = args;
  const greet = name ? `Hey ${name},` : 'Hey there,';
  return {
    subject: 'Your Spooool spot is ready',
    text:
      `${greet}\n\n` +
      `Good news — your spot on the Spooool waitlist is ready. You can sign up now:\n\n` +
      `${signupUrl}\n\n` +
      `Spooool is a creator-first video host. No ads, no algorithm fighting you — just your videos and your audience.\n\n` +
      `Questions? Reply to this email or contact us at hello@spooool.com.\n\n` +
      `— The Spooool team`,
    html:
      `<p>${escapeHtml(greet)}</p>` +
      `<p>Good news — your spot on the Spooool waitlist is ready.</p>` +
      `<p><a href="${escapeHtml(signupUrl)}">Create your account</a></p>` +
      `<p>Spooool is a creator-first video host. No ads, no algorithm fighting you — just your videos and your audience.</p>` +
      `<p>Questions? Reply to this email or contact us at <a href="mailto:hello@spooool.com">hello@spooool.com</a>.</p>`,
  };
}

export async function sendWaitlistInviteEmail(
  env: EmailEnv,
  args: { to: string; name: string | null; signupUrl: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildWaitlistInviteEmail(args) });
}

export async function sendCostAlertEmail(
  env: EmailEnv,
  args: { to: string; props: Record<string, string | number> },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildCostAlertEmail(args.props) });
}

export function buildAccountDeletionEmail(args: {
  name: string;
  deletionDate: string;
  cancelUrl: string;
}): { subject: string; html: string; text: string } {
  const { name, deletionDate, cancelUrl } = args;
  return {
    subject: 'Your Spooool account deletion has been scheduled',
    text:
      `Hi ${name},\n\n` +
      `We received a request to delete your Spooool account. Your account is scheduled for permanent deletion on ${deletionDate} (30 days from now).\n\n` +
      `WHAT WILL HAPPEN ON THAT DATE\n` +
      `• Your videos, profile, and account credentials will be permanently deleted.\n` +
      `• Comments you have posted will remain on the platform but will be anonymised.\n` +
      `• Your subscriptions and any active memberships will be cancelled.\n\n` +
      `TO CANCEL THIS REQUEST\n` +
      `Sign back in to your account at ${cancelUrl} any time before ${deletionDate}.\n\n` +
      `YOUR RIGHTS UNDER GDPR\n` +
      `Under Article 17 of the GDPR you have the right to erasure of your personal data. We will complete this request within 30 days per Article 12(3). To lodge a complaint, contact your local supervisory authority (in the UK: ico.org.uk).\n\n` +
      `If you did not make this request, sign in and cancel immediately, then contact us at privacy@spooool.tv.\n\n` +
      `— The Spooool team`,
    html:
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>We received a request to delete your Spooool account. Your account is scheduled for permanent deletion on <strong>${escapeHtml(deletionDate)}</strong> (30 days from now).</p>` +
      `<p><strong>What will happen on that date:</strong></p>` +
      `<ul>` +
      `<li>Your videos, profile, and account credentials will be permanently deleted.</li>` +
      `<li>Comments you have posted will remain on the platform but will be anonymised.</li>` +
      `<li>Your subscriptions and any active memberships will be cancelled.</li>` +
      `</ul>` +
      `<p><strong>To cancel:</strong> <a href="${cancelUrl}">Sign back in and cancel</a> any time before ${escapeHtml(deletionDate)}.</p>` +
      `<p><strong>Your rights under GDPR:</strong> Under Article 17 you have the right to erasure of your personal data. We will complete this request within 30 days per Article 12(3). To lodge a complaint, contact your local supervisory authority (in the UK: <a href="https://ico.org.uk">ico.org.uk</a>).</p>` +
      `<p>If you did not make this request, sign in and cancel immediately, then contact us at <a href="mailto:privacy@spooool.tv">privacy@spooool.tv</a>.</p>`,
  };
}

export async function sendAccountDeletionEmail(
  env: EmailEnv,
  args: { to: string; name: string; deletionDate: string; cancelUrl: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildAccountDeletionEmail(args) });
}

// LEGAL-REVIEW: placeholder copy — ALO-170. Counsel must approve before launch.
export function buildDmcaUploaderNotifyEmail(args: {
  claimId: string;
  videoId: string;
  counterUrl: string;
}): { subject: string; html: string; text: string } {
  const { claimId, videoId, counterUrl } = args;
  return {
    subject: 'Notice: Your Spooool video has been disabled (DMCA claim)',
    text:
      `Your video (ID: ${videoId}) has been disabled following a DMCA takedown request ` +
      `(claim ID: ${claimId}).\n\n` +
      `If you believe this takedown is mistaken, you may file a counter-notice:\n` +
      `${counterUrl}\n\n` +
      `For questions, contact dmca@spooool.com.`,
    html:
      `<p>Your video (ID: <code>${escapeHtml(videoId)}</code>) has been disabled following ` +
      `a DMCA takedown request (claim ID: <code>${escapeHtml(claimId)}</code>).</p>` +
      `<p>If you believe this takedown is mistaken, you may ` +
      `<a href="${escapeHtml(counterUrl)}">file a counter-notice</a>.</p>` +
      `<p>For questions, contact <a href="mailto:dmca@spooool.com">dmca@spooool.com</a>.</p>`,
  };
}

export async function sendDmcaUploaderNotifyEmail(
  env: EmailEnv,
  args: { to: string; claimId: string; videoId: string; counterUrl: string },
): Promise<EmailResult> {
  return send(env, { to: args.to, ...buildDmcaUploaderNotifyEmail(args) });
}
