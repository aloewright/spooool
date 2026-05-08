import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHeaders,
  parseResendError,
  renderLifecycleEmail,
  sendEmail,
  sendLifecycleEmail,
  unsubscribeContact,
  upsertContact,
} from './resend';

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return await impl(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildHeaders', () => {
  it('emits Bearer token + JSON content type', () => {
    expect(buildHeaders('re_secret')).toEqual({
      Authorization: 'Bearer re_secret',
      'Content-Type': 'application/json',
    });
  });
});

describe('parseResendError', () => {
  it('returns the API message field when present', async () => {
    const res = new Response(JSON.stringify({ message: 'Email required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseResendError(res)).toBe('Email required');
  });

  it('falls back to status when body is not JSON', async () => {
    const res = new Response('not json', { status: 502 });
    expect(await parseResendError(res)).toBe('Resend API 502');
  });
});

describe('sendEmail', () => {
  it('returns skipped result when RESEND_API_KEY is missing', async () => {
    const r = await sendEmail({}, { to: 'a@x.test', subject: 's', html: '<p>x</p>' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'RESEND_API_KEY not configured' });
  });

  it('POSTs to /emails with bearer auth and From fallback', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    mockFetch((url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await sendEmail(
      { RESEND_API_KEY: 're_k', RESEND_FROM: 'sp <s@x.test>' },
      { to: 'a@x.test', subject: 'Hi', html: '<p>hi</p>' },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(seen.url).toBe('https://api.resend.com/emails');
    const headers = (seen.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_k');
    const body = JSON.parse((seen.init?.body as string) ?? '{}');
    expect(body).toEqual({
      from: 'sp <s@x.test>',
      to: ['a@x.test'],
      subject: 'Hi',
      html: '<p>hi</p>',
    });
  });

  it('reports the API error message when Resend returns non-2xx', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: 'Invalid email' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await sendEmail(
      { RESEND_API_KEY: 'k' },
      { to: 'bad', subject: 's', html: '<p/>' },
    );
    expect(r).toEqual({ ok: false, skipped: false, status: 422, message: 'Invalid email' });
  });

  it('catches network errors without throwing', async () => {
    mockFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const r = await sendEmail({ RESEND_API_KEY: 'k' }, { to: 'a@x.test', subject: 's', html: '' });
    expect(r).toMatchObject({ ok: false, skipped: false, status: 0 });
    if (!r.ok && !r.skipped) {
      expect(r.message).toContain('connect ECONNREFUSED');
    }
  });
});

describe('upsertContact', () => {
  it('skips when RESEND_API_KEY is missing', async () => {
    const r = await upsertContact({}, { email: 'a@x.test' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'RESEND_API_KEY not configured' });
  });

  it('skips when RESEND_AUDIENCE_ID is missing', async () => {
    const r = await upsertContact({ RESEND_API_KEY: 'k' }, { email: 'a@x.test' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'RESEND_AUDIENCE_ID not configured' });
  });

  it('PATCHes the contact when it already exists', async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    mockFetch((url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: JSON.parse((init?.body as string) ?? '{}'),
      });
      return new Response('{}', { status: 200 });
    });
    const r = await upsertContact(
      { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1' },
      { email: 'a@x.test', firstName: 'Alice' },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://api.resend.com/audiences/aud_1/contacts/a%40x.test');
    expect(calls[0].body).toMatchObject({ email: 'a@x.test', first_name: 'Alice', unsubscribed: false });
  });

  it('falls back to POST when PATCH 404s', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (init?.method === 'PATCH') return new Response('{}', { status: 404 });
      return new Response('{}', { status: 201 });
    });
    const r = await upsertContact(
      { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1' },
      { email: 'a@x.test' },
    );
    expect(r).toEqual({ ok: true, status: 201 });
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(calls[1].url).toBe('https://api.resend.com/audiences/aud_1/contacts');
  });
});

describe('unsubscribeContact', () => {
  it('skips when API key or audience id is missing', async () => {
    expect(await unsubscribeContact({}, 'a@x.test')).toMatchObject({ skipped: true });
    expect(await unsubscribeContact({ RESEND_API_KEY: 'k' }, 'a@x.test')).toMatchObject({
      skipped: true,
    });
  });

  it('PATCHes /audiences/:id/contacts/:email with unsubscribed=true', async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch((url, init) => {
      captured = { url, body: JSON.parse((init?.body as string) ?? '{}') };
      return new Response('{}', { status: 200 });
    });
    const r = await unsubscribeContact(
      { RESEND_API_KEY: 'k', RESEND_AUDIENCE_ID: 'aud_1' },
      'a@x.test',
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(captured.url).toBe('https://api.resend.com/audiences/aud_1/contacts/a%40x.test');
    expect(captured.body).toEqual({ unsubscribed: true });
  });
});

describe('renderLifecycleEmail', () => {
  it('escapes user-controlled values in the subject/html', () => {
    const out = renderLifecycleEmail({ kind: 'signup', firstName: '<script>x</script>' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('renders distinct subjects per kind', () => {
    expect(renderLifecycleEmail({ kind: 'email_verification', verifyUrl: 'https://x' }).subject).toMatch(/Verify/);
    expect(renderLifecycleEmail({ kind: 'password_reset', resetUrl: 'https://x' }).subject).toMatch(/Reset/);
    expect(renderLifecycleEmail({ kind: 'signup' }).subject).toMatch(/Welcome/);
  });
});

describe('sendLifecycleEmail', () => {
  it('routes through sendEmail with rendered subject + html', async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse((init?.body as string) ?? '{}');
      return new Response('{}', { status: 200 });
    });
    const r = await sendLifecycleEmail(
      { RESEND_API_KEY: 'k' },
      'a@x.test',
      { kind: 'email_verification', verifyUrl: 'https://x/v?t=tok' },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(body.to).toEqual(['a@x.test']);
    expect(body.subject).toBe('Verify your spooool email');
    expect(String(body.html)).toContain('https://x/v?t=tok');
  });
});
