// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { PostHog } from 'posthog-js';

const config = {
  api_host: 'https://example.invalid',
  advanced_disable_decide: true,
  autocapture: false,
  capture_pageview: false,
  disable_session_recording: true,
};

afterEach(() => window.localStorage.clear());

describe('PostHog anonymous identity persistence probe', () => {
  it('preserves the exact returning anonymous distinct id', () => {
    const first = new PostHog();
    first.init('phc_anonymous_probe', config);
    const originalDistinctId = first.get_distinct_id();

    const returning = new PostHog();
    returning.init('phc_anonymous_probe', config);

    expect(returning.get_property('$user_state')).toBe('anonymous');
    expect(returning.get_distinct_id()).toBe(originalDistinctId);
  });

  it('replaces a persisted identified distinct id with a new anonymous id', () => {
    const first = new PostHog();
    first.init('phc_identified_probe', config);
    first.register({ distinct_id: 'former-user', $user_state: 'identified' });

    const expired = new PostHog();
    expired.init('phc_identified_probe', config);
    expect(expired.get_property('$user_state')).toBe('identified');

    expired.reset();

    expect(expired.get_property('$user_state')).toBe('anonymous');
    expect(expired.get_distinct_id()).not.toBe('former-user');
  });
});
