import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHeaders,
  parseLoopsError,
  sendEvent,
  unsubscribeContact,
  upsertContact,
} from './loops';

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return await impl(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // restore between tests so each one installs its own mock
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildHeaders', () => {
  it('emits Bearer token + JSON content type', () => {
    expect(buildHeaders('k_secret')).toEqual({
      Authorization: 'Bearer k_secret',
      'Content-Type': 'application/json',
    });
  });
});

describe('parseLoopsError', () => {
  it('returns the API message field when present', async () => {
    const res = new Response(JSON.stringify({ message: 'Email required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseLoopsError(res)).toBe('Email required');
  });

  it('falls back to error field', async () => {
    const res = new Response(JSON.stringify({ error: 'Bad key' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    expect(await parseLoopsError(res)).toBe('Bad key');
  });

  it('falls back to status when body is not JSON', async () => {
    const res = new Response('not json', { status: 502 });
    expect(await parseLoopsError(res)).toBe('Loops API 502');
  });
});

describe('upsertContact', () => {
  it('returns skipped result when LOOPS_API_KEY is missing', async () => {
    const r = await upsertContact({}, { email: 'a@x.test' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' });
  });

  it('POSTs to /v1/contacts/update with bearer auth and returns ok', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    mockFetch((url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const r = await upsertContact(
      { LOOPS_API_KEY: 'k_secret' },
      { email: 'a@x.test', firstName: 'Alice', userId: 'u_1', subscribed: true },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(seen.url).toBe('https://app.loops.so/api/v1/contacts/update');
    const headers = (seen.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k_secret');
    const body = JSON.parse((seen.init?.body as string) ?? '{}');
    expect(body).toMatchObject({
      email: 'a@x.test',
      firstName: 'Alice',
      userId: 'u_1',
      subscribed: true,
    });
  });

  it('reports the API error message when Loops returns non-2xx', async () => {
    mockFetch(
      () => new Response(JSON.stringify({ message: 'Invalid email' }), { status: 422, headers: { 'content-type': 'application/json' } }),
    );
    const r = await upsertContact({ LOOPS_API_KEY: 'k' }, { email: 'bad' });
    expect(r).toEqual({ ok: false, skipped: false, status: 422, message: 'Invalid email' });
  });

  it('catches network errors and reports them without throwing', async () => {
    mockFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const r = await upsertContact({ LOOPS_API_KEY: 'k' }, { email: 'a@x.test' });
    expect(r).toMatchObject({ ok: false, skipped: false, status: 0 });
    if (!r.ok && !r.skipped) {
      expect(r.message).toContain('connect ECONNREFUSED');
    }
  });
});

describe('unsubscribeContact', () => {
  it('skips silently when no API key is configured', async () => {
    const r = await unsubscribeContact({}, 'a@x.test');
    expect(r).toEqual({ ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' });
  });

  it('sends subscribed=false to /contacts/update', async () => {
    let captured: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      captured = JSON.parse((init?.body as string) ?? '{}');
      return new Response('{}', { status: 200 });
    });
    const r = await unsubscribeContact({ LOOPS_API_KEY: 'k' }, 'a@x.test');
    expect(r).toEqual({ ok: true, status: 200 });
    expect(captured).toEqual({ email: 'a@x.test', subscribed: false });
  });
});

describe('sendEvent', () => {
  it('skips silently when no API key is configured', async () => {
    const r = await sendEvent({}, { email: 'a@x.test', eventName: 'signup' });
    expect(r).toEqual({ ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' });
  });

  it('POSTs to /events/send with the event name + properties', async () => {
    let captured: Record<string, unknown> = {};
    let url = '';
    mockFetch((u, init) => {
      url = u;
      captured = JSON.parse((init?.body as string) ?? '{}');
      return new Response('{}', { status: 200 });
    });
    const r = await sendEvent(
      { LOOPS_API_KEY: 'k' },
      { email: 'a@x.test', eventName: 'first_upload', eventProperties: { videoId: 'v1' } },
    );
    expect(r).toEqual({ ok: true, status: 200 });
    expect(url).toBe('https://app.loops.so/api/v1/events/send');
    expect(captured).toMatchObject({
      email: 'a@x.test',
      eventName: 'first_upload',
      eventProperties: { videoId: 'v1' },
    });
  });

  it('defaults eventProperties to an empty object when omitted', async () => {
    let captured: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      captured = JSON.parse((init?.body as string) ?? '{}');
      return new Response('{}', { status: 200 });
    });
    await sendEvent({ LOOPS_API_KEY: 'k' }, { email: 'a@x.test', eventName: 'hello' });
    expect(captured.eventProperties).toEqual({});
  });
});
