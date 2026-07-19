// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PostHog } from 'posthog-js';

describe('PostHog consent lifecycle probe', () => {
  it('remains opted out after reset, then intentionally resumes capture on reacceptance', () => {
    const client = new PostHog();
    client.init('phc_probe', {
      api_host: 'https://example.invalid',
      advanced_disable_decide: true,
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      persistence: 'memory',
    });

    // This is the adapter's withdrawal order. The adapter's mocked lifecycle
    // test separately asserts this exact call ordering.
    client.reset();
    client.opt_out_capturing();

    expect(client.has_opted_out_capturing()).toBe(true);
    expect(client.is_capturing()).toBe(false);

    client.opt_in_capturing({ captureEventName: false });

    expect(client.has_opted_out_capturing()).toBe(false);
    expect(client.is_capturing()).toBe(true);
  });
});
