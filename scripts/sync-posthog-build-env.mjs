#!/usr/bin/env node

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Build the narrow PATCH payload used by the Workers Builds API. PATCH merges
 * these values with a trigger's existing environment variables.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function buildPosthogVariables(env) {
  if (!env.VITE_POSTHOG_KEY) {
    throw new Error('VITE_POSTHOG_KEY is required to configure PostHog for Workers Builds.');
  }

  return {
    VITE_POSTHOG_KEY: { value: env.VITE_POSTHOG_KEY, is_secret: true },
    VITE_POSTHOG_HOST: {
      value: env.VITE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
      is_secret: false,
    },
  };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function cloudflareAuthHeaders(env) {
  if (env.CLOUDFLARE_API_TOKEN) {
    return { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  }

  if (env.CLOUDFLARE_EMAIL && env.CLOUDFLARE_API_KEY) {
    return {
      'X-Auth-Email': env.CLOUDFLARE_EMAIL,
      'X-Auth-Key': env.CLOUDFLARE_API_KEY,
    };
  }

  throw new Error(
    'Cloudflare credentials are required: set CLOUDFLARE_API_TOKEN or both CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY.',
  );
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function legacyAuthHeaders(env) {
  if (!env.CLOUDFLARE_EMAIL || !env.CLOUDFLARE_API_KEY) return null;
  return {
    'X-Auth-Email': env.CLOUDFLARE_EMAIL,
    'X-Auth-Key': env.CLOUDFLARE_API_KEY,
  };
}

function cloudflareErrorMessage(payload) {
  const messages = Array.isArray(payload?.errors)
    ? payload.errors
      .map((error) => (typeof error?.message === 'string' ? error.message : ''))
      .filter(Boolean)
    : [];
  return messages.join('; ') || 'unknown Cloudflare API error';
}

/**
 * @param {{
 *   env: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   fetchImpl: typeof fetch,
 *   workerName: string,
 * }} options
 */
export async function syncPosthogBuildEnv({ env, fetchImpl = fetch, workerName }) {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is required to configure Workers Builds.');
  }
  if (!workerName) {
    throw new Error('A Worker name is required to configure Workers Builds.');
  }

  const variables = buildPosthogVariables(env);
  const authHeaders = cloudflareAuthHeaders(env);
  const retryHeaders = env.CLOUDFLARE_API_TOKEN ? legacyAuthHeaders(env) : null;

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   */
  const request = async (path, init = {}) => {
    const send = async (headers) => {
      try {
        return await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
          ...init,
          headers: { ...headers, ...init.headers },
        });
      } catch {
        throw new Error('Cloudflare API network request failed.');
      }
    };

    let response = await send(authHeaders);
    if (retryHeaders && (response.status === 401 || response.status === 403)) {
      response = await send(retryHeaders);
    }

    if (!response.ok) {
      throw new Error(`Cloudflare API request failed with HTTP ${response.status}.`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Cloudflare API returned an invalid JSON response.');
    }

    if (!payload?.success) {
      throw new Error(`Cloudflare API reported failure: ${cloudflareErrorMessage(payload)}.`);
    }

    return payload.result;
  };

  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const scripts = await request(`/accounts/${accountId}/workers/scripts`);
  const worker = Array.isArray(scripts) ? scripts.find((script) => script?.id === workerName) : undefined;
  if (!worker) {
    throw new Error(`Worker "${workerName}" was not found in the Cloudflare account.`);
  }
  if (!worker.tag) {
    throw new Error(`Worker "${workerName}" does not include an immutable tag for Workers Builds.`);
  }

  const workerTag = encodeURIComponent(worker.tag);
  const triggers = await request(`/accounts/${accountId}/builds/workers/${workerTag}/triggers`);
  if (!Array.isArray(triggers) || triggers.length === 0) {
    throw new Error(`Worker "${workerName}" has no Workers Builds triggers to configure.`);
  }

  const configured = [];
  for (const trigger of triggers) {
    if (!trigger?.trigger_uuid || !trigger?.trigger_name) {
      throw new Error('Cloudflare returned a Workers Builds trigger without an identifier or name.');
    }
    const triggerId = encodeURIComponent(trigger.trigger_uuid);
    await request(`/accounts/${accountId}/builds/triggers/${triggerId}/environment_variables`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(variables),
    });
    configured.push(trigger.trigger_name);
  }

  return configured;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  syncPosthogBuildEnv({ env: process.env, fetchImpl: fetch, workerName: 'spooool' })
    .then((triggerNames) => {
      for (const triggerName of triggerNames) {
        console.log(`Configured PostHog for Workers Builds trigger: ${triggerName}`);
      }
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : 'PostHog build environment sync failed.'}`);
      process.exitCode = 1;
    });
}
