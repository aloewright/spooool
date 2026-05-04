import { describe, expect, it } from 'vitest';
import {
  NEVER_SYNC_TO_WORKER,
  parseArgs,
  partition,
  quoteForDotenv,
  shellQuote,
} from './sync-doppler-secrets.mjs';

describe('parseArgs', () => {
  it('extracts the subcommand', () => {
    const { subcommand } = parseArgs(['node', 'script', 'sync-worker-secrets']);
    expect(subcommand).toBe('sync-worker-secrets');
  });

  it('parses --flag=value', () => {
    const { flags } = parseArgs(['node', 'script', 'cmd', '--env=staging', '--filter=VITE_']);
    expect(flags.env).toBe('staging');
    expect(flags.filter).toBe('VITE_');
  });

  it('parses bare --flag as boolean true', () => {
    const { flags } = parseArgs(['node', 'script', 'cmd', '--verbose']);
    expect(flags.verbose).toBe(true);
  });
});

describe('partition', () => {
  it('routes VITE_* to vite', () => {
    const { vite, worker, cloudflare } = partition({
      VITE_POSTHOG_KEY: 'phc_test',
      VITE_SENTRY_DSN: 'https://x@sentry/1',
    });
    expect(vite).toEqual({
      VITE_POSTHOG_KEY: 'phc_test',
      VITE_SENTRY_DSN: 'https://x@sentry/1',
    });
    expect(worker).toEqual({});
    expect(cloudflare).toEqual({});
  });

  it('routes CLOUDFLARE_* to cloudflare and never to worker', () => {
    const { cloudflare, worker } = partition({
      CLOUDFLARE_API_TOKEN: 'cf_token',
      CLOUDFLARE_ACCOUNT_ID: 'cf_account',
    });
    expect(cloudflare).toEqual({
      CLOUDFLARE_API_TOKEN: 'cf_token',
      CLOUDFLARE_ACCOUNT_ID: 'cf_account',
    });
    expect(worker).toEqual({});
  });

  it('routes everything else to worker', () => {
    const { worker } = partition({
      SENTRY_DSN: 'https://w@sentry/1',
      LOOPS_API_KEY: 'loop_test',
      BETTER_AUTH_SECRET: 'random-32',
    });
    expect(worker).toEqual({
      SENTRY_DSN: 'https://w@sentry/1',
      LOOPS_API_KEY: 'loop_test',
      BETTER_AUTH_SECRET: 'random-32',
    });
  });

  it('drops DOPPLER_* meta keys from every bucket', () => {
    const { worker, vite, cloudflare } = partition({
      DOPPLER_TOKEN: 'dp_token',
      DOPPLER_PROJECT: 'spooool',
      DOPPLER_CONFIG: 'staging',
      DOPPLER_ENVIRONMENT: 'staging',
      KEEP_ME: 'yes',
    });
    expect(worker).toEqual({ KEEP_ME: 'yes' });
    expect(vite).toEqual({});
    expect(cloudflare).toEqual({});
  });

  it('coerces null/undefined values to empty strings rather than crashing', () => {
    const { worker } = partition({ FOO: null, BAR: undefined });
    expect(worker).toEqual({ FOO: '', BAR: '' });
  });

  it('NEVER_SYNC_TO_WORKER includes both Doppler meta and Cloudflare creds', () => {
    expect(NEVER_SYNC_TO_WORKER.has('DOPPLER_TOKEN')).toBe(true);
    expect(NEVER_SYNC_TO_WORKER.has('CLOUDFLARE_API_TOKEN')).toBe(true);
    expect(NEVER_SYNC_TO_WORKER.has('SENTRY_DSN')).toBe(false);
  });
});

describe('quoteForDotenv', () => {
  it('passes plain values through unquoted', () => {
    expect(quoteForDotenv('phc_abc123')).toBe('phc_abc123');
    expect(quoteForDotenv('123')).toBe('123');
  });

  it('quotes values with whitespace', () => {
    expect(quoteForDotenv('with space')).toBe('"with space"');
  });

  it('escapes double-quotes inside the value', () => {
    expect(quoteForDotenv('a"b')).toBe('"a\\"b"');
  });

  it('escapes backslashes and dollar signs', () => {
    expect(quoteForDotenv('a\\b')).toBe('"a\\\\b"');
    expect(quoteForDotenv('$VAR')).toBe('"\\$VAR"');
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it("escapes single quotes inside the value via the standard '\\'' trick", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('handles values with shell metacharacters safely', () => {
    expect(shellQuote('a$b`c"d')).toBe('\'a$b`c"d\'');
  });
});
