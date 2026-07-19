import { describe, expect, it, vi } from 'vitest';
import {
  buildPosthogVariables,
  cloudflareAuthHeaders,
  syncPosthogBuildEnv,
} from './sync-posthog-build-env.mjs';

const configuredEnv = {
  VITE_POSTHOG_KEY: 'phc_test',
  VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
  CLOUDFLARE_ACCOUNT_ID: 'account-1',
  CLOUDFLARE_API_TOKEN: 'cf-token',
};

function successfulFetch({ triggers = [{ trigger_uuid: 'production', trigger_name: 'Production' }] } = {}) {
  return vi.fn()
    .mockResolvedValueOnce(Response.json({
      success: true,
      result: [{ id: 'spooool', tag: 'worker-tag' }],
    }))
    .mockResolvedValueOnce(Response.json({ success: true, result: triggers }))
    .mockImplementation(() => Promise.resolve(Response.json({ success: true, result: {} })));
}

describe('buildPosthogVariables', () => {
  it('builds only the two PostHog Workers Builds variables', () => {
    expect(buildPosthogVariables(configuredEnv)).toEqual({
      VITE_POSTHOG_KEY: { value: 'phc_test', is_secret: true },
      VITE_POSTHOG_HOST: { value: 'https://us.i.posthog.com', is_secret: false },
    });
  });

  it('uses the US PostHog host when none is configured', () => {
    expect(buildPosthogVariables({ VITE_POSTHOG_KEY: 'phc_test' })).toEqual({
      VITE_POSTHOG_KEY: { value: 'phc_test', is_secret: true },
      VITE_POSTHOG_HOST: { value: 'https://us.i.posthog.com', is_secret: false },
    });
  });

  it('rejects a missing project token without including its value', () => {
    expect(() => buildPosthogVariables({})).toThrow('VITE_POSTHOG_KEY is required');
  });
});

describe('cloudflareAuthHeaders', () => {
  it('prefers bearer auth and supports legacy user credentials', () => {
    expect(cloudflareAuthHeaders(configuredEnv)).toEqual({ Authorization: 'Bearer cf-token' });
    expect(cloudflareAuthHeaders({
      CLOUDFLARE_EMAIL: 'owner@example.com',
      CLOUDFLARE_API_KEY: 'global-key',
    })).toEqual({ 'X-Auth-Email': 'owner@example.com', 'X-Auth-Key': 'global-key' });
  });

  it('rejects incomplete or missing Cloudflare credentials', () => {
    expect(() => cloudflareAuthHeaders({})).toThrow('Cloudflare credentials are required');
    expect(() => cloudflareAuthHeaders({ CLOUDFLARE_EMAIL: 'owner@example.com' }))
      .toThrow('Cloudflare credentials are required');
  });
});

describe('syncPosthogBuildEnv', () => {
  it('requires a Cloudflare account id', async () => {
    await expect(syncPosthogBuildEnv({
      env: { ...configuredEnv, CLOUDFLARE_ACCOUNT_ID: '' },
      fetchImpl: vi.fn(),
      workerName: 'spooool',
    })).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID is required');
  });

  it('retries an unauthorized bearer request with available legacy credentials', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
        { status: 403 },
      ))
      .mockResolvedValueOnce(Response.json({
        success: true,
        result: [{ id: 'spooool', tag: 'worker-tag' }],
      }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [
        { trigger_uuid: 'production', trigger_name: 'Production' },
      ] }))
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));

    await syncPosthogBuildEnv({
      env: {
        ...configuredEnv,
        CLOUDFLARE_EMAIL: 'owner@example.com',
        CLOUDFLARE_API_KEY: 'global-key',
      },
      fetchImpl,
      workerName: 'spooool',
    });

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer cf-token' });
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({
      'X-Auth-Email': 'owner@example.com',
      'X-Auth-Key': 'global-key',
    });
  });

  it('patches every trigger attached to the named worker', async () => {
    const fetchImpl = successfulFetch({
      triggers: [
        { trigger_uuid: 'preview', trigger_name: 'Preview' },
        { trigger_uuid: 'production', trigger_name: 'Production' },
      ],
    });

    const result = await syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' });

    expect(result).toEqual(['Preview', 'Production']);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls.slice(2)) {
      expect(call[1].method).toBe('PATCH');
      expect(JSON.parse(call[1].body)).toEqual(buildPosthogVariables(configuredEnv));
    }
  });

  it('throws when the named Worker cannot be found', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ success: true, result: [] }));

    await expect(syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' }))
      .rejects.toThrow('Worker "spooool" was not found');
  });

  it('throws when the Worker has no build triggers', async () => {
    const fetchImpl = successfulFetch({ triggers: [] });

    await expect(syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' }))
      .rejects.toThrow('no Workers Builds triggers');
  });

  it('throws an actionable error when Cloudflare reports failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({
      success: false,
      errors: [{ code: 7000, message: 'worker list unavailable' }],
    }));

    await expect(syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' }))
      .rejects.toThrow('Cloudflare API reported failure: worker list unavailable');
  });

  it('does not retry non-authentication HTTP failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { success: false, errors: [{ message: 'server error' }] },
      { status: 500 },
    ));

    await expect(syncPosthogBuildEnv({
      env: {
        ...configuredEnv,
        CLOUDFLARE_EMAIL: 'owner@example.com',
        CLOUDFLARE_API_KEY: 'global-key',
      },
      fetchImpl,
      workerName: 'spooool',
    })).rejects.toThrow('Cloudflare API request failed with HTTP 500');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('wraps network failures without leaking request details', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket closed'));

    await expect(syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' }))
      .rejects.toThrow('Cloudflare API network request failed');
  });
});
