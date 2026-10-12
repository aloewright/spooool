import { describe, expect, it, vi } from 'vitest';
import {
  buildDmcaAcknowledgmentEmail,
  buildPasswordResetConfirmationEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
  sendDmcaAcknowledgmentEmail,
  sendPasswordResetConfirmationEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
  type EmailBinding,
} from './email';

function fakeBinding(
  impl: (msg: Parameters<EmailBinding['send']>[0]) => Promise<{ messageId?: string }> = async () => ({
    messageId: 'm1',
  }),
): EmailBinding & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(impl) } as never;
}

describe('build*Email helpers', () => {
  it('password reset includes the url in both text and html', () => {
    const m = buildPasswordResetEmail('https://x/reset?token=tok');
    expect(m.subject).toMatch(/reset/i);
    expect(m.text).toContain('https://x/reset?token=tok');
    expect(m.html).toContain('https://x/reset?token=tok');
  });

  it('verification mentions verify and embeds the url', () => {
    const m = buildVerificationEmail('https://x/verify?token=tok');
    expect(m.subject).toMatch(/verify/i);
    expect(m.html).toContain('https://x/verify?token=tok');
  });

  it('confirmation email has no link', () => {
    const m = buildPasswordResetConfirmationEmail();
    expect(m.html).not.toContain('href');
    expect(m.text).toMatch(/changed/i);
  });

  it('welcome greets by first name when provided', () => {
    expect(buildWelcomeEmail('Alice').text).toContain('Hey Alice');
    expect(buildWelcomeEmail().text).toContain('Hey there');
  });
});

describe('sendPasswordResetEmail', () => {
  it('returns skipped when EMAIL binding is missing', async () => {
    const r = await sendPasswordResetEmail({}, { to: 'a@x.test', url: 'https://x' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'EMAIL binding not configured' });
  });

  it('forwards to env.EMAIL.send with the configured from address', async () => {
    const binding = fakeBinding();
    const r = await sendPasswordResetEmail(
      { EMAIL: binding, EMAIL_FROM: 'no-reply@x.test', EMAIL_FROM_NAME: 'Spool' },
      { to: 'u@x.test', url: 'https://x/reset' },
    );
    expect(r).toEqual({ ok: true, messageId: 'm1' });
    const sent = binding.send.mock.calls[0][0];
    expect(sent).toMatchObject({
      to: 'u@x.test',
      from: { email: 'no-reply@x.test', name: 'Spool' },
    });
    expect(sent.text).toContain('https://x/reset');
    expect(sent.html).toContain('https://x/reset');
  });

  it('falls back to default from when env vars are unset', async () => {
    const binding = fakeBinding();
    await sendPasswordResetEmail({ EMAIL: binding }, { to: 'u@x.test', url: 'https://x/r' });
    const sent = binding.send.mock.calls[0][0];
    expect(sent.from).toEqual({ email: 'noreply@spooool.com', name: 'Spooool' });
  });

  it('catches send errors and reports them without throwing', async () => {
    const binding = fakeBinding(async () => {
      throw new Error('network down');
    });
    const r = await sendPasswordResetEmail({ EMAIL: binding }, { to: 'u@x.test', url: 'https://x' });
    expect(r).toMatchObject({ ok: false, skipped: false });
    if (!r.ok && !r.skipped) {
      expect(r.message).toContain('network down');
    }
  });
});

describe('sendVerificationEmail', () => {
  it('forwards verify url to env.EMAIL.send', async () => {
    const binding = fakeBinding();
    const r = await sendVerificationEmail(
      { EMAIL: binding },
      { to: 'u@x.test', url: 'https://x/verify' },
    );
    expect(r.ok).toBe(true);
    expect(binding.send.mock.calls[0][0].html).toContain('https://x/verify');
  });
});

describe('sendPasswordResetConfirmationEmail', () => {
  it('sends without a reset url', async () => {
    const binding = fakeBinding();
    const r = await sendPasswordResetConfirmationEmail({ EMAIL: binding }, { to: 'u@x.test' });
    expect(r.ok).toBe(true);
    expect(binding.send.mock.calls[0][0].subject).toMatch(/changed/i);
  });
});

describe('sendWelcomeEmail', () => {
  it('sends a personalised welcome when first name is provided', async () => {
    const binding = fakeBinding();
    await sendWelcomeEmail({ EMAIL: binding }, { to: 'u@x.test', firstName: 'Alice' });
    expect(binding.send.mock.calls[0][0].text).toContain('Hey Alice');
  });
});

describe('buildDmcaAcknowledgmentEmail', () => {
  it('includes claim id, video id, and § 512 reference in both parts', () => {
    const m = buildDmcaAcknowledgmentEmail({ claimId: 'c-123', videoId: 'v-456' });
    expect(m.subject).toContain('c-123');
    expect(m.text).toContain('c-123');
    expect(m.text).toContain('v-456');
    expect(m.text).toContain('17 U.S.C. § 512');
    expect(m.html).toContain('c-123');
    expect(m.html).toContain('v-456');
  });

  it('subject line mentions the claim id', () => {
    const m = buildDmcaAcknowledgmentEmail({ claimId: 'abc', videoId: 'xyz' });
    expect(m.subject).toMatch(/abc/);
  });
});

describe('sendDmcaAcknowledgmentEmail', () => {
  it('returns skipped when EMAIL binding is missing', async () => {
    const r = await sendDmcaAcknowledgmentEmail({}, { to: 'c@x.test', claimId: 'c1', videoId: 'v1' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'EMAIL binding not configured' });
  });

  it('sends to complainant with claim and video ids', async () => {
    const binding = fakeBinding();
    const r = await sendDmcaAcknowledgmentEmail(
      { EMAIL: binding },
      { to: 'c@x.test', claimId: 'c-99', videoId: 'v-77' },
    );
    expect(r.ok).toBe(true);
    const sent = binding.send.mock.calls[0][0];
    expect(sent.to).toBe('c@x.test');
    expect(sent.text).toContain('c-99');
    expect(sent.text).toContain('v-77');
  });
});
