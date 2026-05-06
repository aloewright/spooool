import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeUserAgent,
  formatDate,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from './sessions';

describe('formatDate', () => {
  it('renders an ISO string in UTC', () => {
    expect(formatDate('2026-01-02T03:04:05.000Z')).toMatch(/^Fri, 02 Jan 2026 03:04:05 GMT$/);
  });
  it('renders an epoch ms number in UTC', () => {
    expect(formatDate(1767322445000)).toMatch(/Jan 2026/);
  });
  it('returns em-dash for null/undefined/invalid', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('describeUserAgent', () => {
  it('combines browser and parenthetical when both present', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(describeUserAgent(ua)).toContain('Chrome/120.0.0.0');
    expect(describeUserAgent(ua)).toContain('Macintosh');
  });
  it('falls back to parenthetical only when no browser token', () => {
    const ua = 'curl/8.0 (linux x86_64)';
    expect(describeUserAgent(ua)).toBe('linux x86_64');
  });
  it('falls back to "Unknown device" for empty', () => {
    expect(describeUserAgent(undefined)).toBe('Unknown device');
    expect(describeUserAgent('')).toBe('Unknown device');
  });
});

describe('listSessions', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the array body when the response is a bare array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 's1', token: 't1', expiresAt: 1, createdAt: 1 }]), {
        status: 200,
      }),
    );
    const out = await listSessions();
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('s1');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/list-sessions', { credentials: 'same-origin' });
  });

  it('unwraps a { sessions: [...] } envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: [{ id: 's2', token: 't2', expiresAt: 1, createdAt: 1 }] }), {
        status: 200,
      }),
    );
    const out = await listSessions();
    expect(out[0]?.id).toBe('s2');
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await expect(listSessions()).rejects.toThrow(/500/);
  });
});

describe('revokeSession', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the token JSON to the better-auth endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await revokeSession('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/revoke-session');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 'tok-1' });
  });

  it('surfaces server-provided error messages', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Session expired' }), { status: 401 }),
    );
    await expect(revokeSession('tok-1')).rejects.toThrow('Session expired');
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 500 }));
    await expect(revokeSession('tok-1')).rejects.toThrow('Could not revoke session');
  });
});

describe('revokeOtherSessions', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to the better-auth endpoint with an empty body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await revokeOtherSessions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/revoke-other-sessions');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('throws on failure with server error message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    );
    await expect(revokeOtherSessions()).rejects.toThrow('Forbidden');
  });
});
