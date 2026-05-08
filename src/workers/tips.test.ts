import { describe, expect, it } from 'vitest';
import {
  computePlatformFee,
  handleStripeWebhook,
  MAX_MESSAGE_LENGTH,
  MAX_TIP_CENTS,
  MIN_TIP_CENTS,
  parseStripeMetadata,
  validateTipInput,
  type TipsEnv,
} from './tips';

describe('computePlatformFee', () => {
  it('takes 10% on tips at or above the floor threshold', () => {
    expect(computePlatformFee(1000)).toBe(100);
    expect(computePlatformFee(2500)).toBe(250);
  });

  it('floors the fee at 30¢ for tips ≥ $1 when 10% would be smaller', () => {
    // 10% of $1.00 = 10¢ → bumped to floor.
    expect(computePlatformFee(100)).toBe(30);
    // 10% of $2.50 = 25¢ → bumped to floor.
    expect(computePlatformFee(250)).toBe(30);
    // 10% of $3.00 = 30¢ exactly.
    expect(computePlatformFee(300)).toBe(30);
  });

  it('does not apply the floor on micro-tips below $1', () => {
    // We never accept these in practice (MIN_TIP_CENTS = 100), but the fee
    // function should remain pure & not surprise callers.
    expect(computePlatformFee(50)).toBe(5);
  });
});

describe('validateTipInput', () => {
  it('rejects non-objects and missing amounts', () => {
    expect(validateTipInput(null)).toBe('amount_invalid');
    expect(validateTipInput('hi')).toBe('amount_invalid');
    expect(validateTipInput({})).toBe('amount_invalid');
    expect(validateTipInput({ amount_cents: 'a lot' })).toBe('amount_invalid');
    expect(validateTipInput({ amount_cents: 1.5 })).toBe('amount_invalid');
  });

  it('enforces tip bounds', () => {
    expect(validateTipInput({ amount_cents: MIN_TIP_CENTS - 1 })).toBe('amount_too_small');
    expect(validateTipInput({ amount_cents: MAX_TIP_CENTS + 1 })).toBe('amount_too_large');
  });

  it('caps message length and trims whitespace', () => {
    const longMsg = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(validateTipInput({ amount_cents: 500, message: longMsg })).toBe('message_too_long');
    const ok = validateTipInput({ amount_cents: 500, message: '   thanks!   ' });
    expect(ok).toEqual({ amountCents: 500, message: 'thanks!', anonymous: false });
  });

  it('treats empty / whitespace-only messages as no message', () => {
    expect(validateTipInput({ amount_cents: 500, message: '   ' })).toEqual({
      amountCents: 500,
      message: null,
      anonymous: false,
    });
  });

  it('parses anonymous flag strictly (only literal true counts)', () => {
    expect(validateTipInput({ amount_cents: 500, anonymous: true })).toEqual({
      amountCents: 500,
      message: null,
      anonymous: true,
    });
    expect(validateTipInput({ amount_cents: 500, anonymous: 'true' })).toEqual({
      amountCents: 500,
      message: null,
      anonymous: false,
    });
  });
});

describe('parseStripeMetadata', () => {
  it('returns null when any required key is missing', () => {
    expect(parseStripeMetadata(null)).toBeNull();
    expect(parseStripeMetadata({})).toBeNull();
    expect(parseStripeMetadata({ tip_id: 't', video_id: 'v' })).toBeNull();
  });

  it('returns the typed metadata when complete', () => {
    expect(
      parseStripeMetadata({ tip_id: 't', video_id: 'v', creator_user_id: 'u', extra: 'ignored' }),
    ).toEqual({ tip_id: 't', video_id: 'v', creator_user_id: 'u' });
  });
});

describe('handleStripeWebhook', () => {
  // 503 paths don't require a signed body, so we can exercise them without
  // pulling in the Stripe signing helper.
  it('returns 503 when STRIPE_SECRET_KEY is unset', async () => {
    const env: TipsEnv = { DB: {} as D1Database };
    const req = new Request('https://x.test/api/webhooks/stripe', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': 'sig' },
    });
    const res = await handleStripeWebhook(env, req);
    expect(res.status).toBe(503);
  });

  it('returns 503 when STRIPE_WEBHOOK_SECRET is unset', async () => {
    const env: TipsEnv = {
      DB: {} as D1Database,
      STRIPE_SECRET_KEY: 'sk_test_x',
    };
    const req = new Request('https://x.test/api/webhooks/stripe', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': 'sig' },
    });
    const res = await handleStripeWebhook(env, req);
    expect(res.status).toBe(503);
  });

  it('returns 400 when the stripe-signature header is missing', async () => {
    const env: TipsEnv = {
      DB: {} as D1Database,
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
    };
    const req = new Request('https://x.test/api/webhooks/stripe', {
      method: 'POST',
      body: '{}',
    });
    const res = await handleStripeWebhook(env, req);
    expect(res.status).toBe(400);
  });

  // Integration of the *signed* path is exercised via the shared sign/verify
  // helper in stream-webhook.test.ts; replicating it here would couple the
  // test to Stripe's internal signing format. Route-level coverage of the
  // unsigned failure modes is enough — the handler delegates to
  // stripe.webhooks.constructEventAsync once it gets past these checks.
});
