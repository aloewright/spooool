import { describe, expect, it } from 'vitest';
import {
  ACTIVE_MEMBERSHIP_STATUSES,
  applyStripeEvent,
  isActiveMembershipStatus,
  membershipIsActive,
} from './memberships';
import type Stripe from 'stripe';

describe('isActiveMembershipStatus', () => {
  it('treats active and trialing as active', () => {
    expect(isActiveMembershipStatus('active')).toBe(true);
    expect(isActiveMembershipStatus('trialing')).toBe(true);
  });

  it('treats every other Stripe status as inactive', () => {
    for (const s of [
      'incomplete',
      'incomplete_expired',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
      // Anything we haven't seen falls through to "inactive" — fail closed.
      'something_weird',
    ]) {
      expect(isActiveMembershipStatus(s)).toBe(false);
    }
  });

  it('exposes the active set as a tuple of strings', () => {
    expect([...ACTIVE_MEMBERSHIP_STATUSES].sort()).toEqual(['active', 'trialing']);
  });
});

describe('membershipIsActive', () => {
  const NOW = 1_700_000_000;

  it('false when row missing', () => {
    expect(membershipIsActive(null, NOW)).toBe(false);
    expect(membershipIsActive(undefined, NOW)).toBe(false);
  });

  it('true when status=active and current_period_end is in the future', () => {
    expect(
      membershipIsActive({ status: 'active', current_period_end: NOW + 60 }, NOW),
    ).toBe(true);
  });

  it('false when status=active but current_period_end already passed', () => {
    // Stripe sometimes leaves a sub at status=active for a brief window after
    // the period end before the cron downgrades to past_due. Honor the clock.
    expect(
      membershipIsActive({ status: 'active', current_period_end: NOW - 1 }, NOW),
    ).toBe(false);
  });

  it('true when status=active and period_end is null (fresh sub, not yet reported)', () => {
    expect(
      membershipIsActive({ status: 'active', current_period_end: null }, NOW),
    ).toBe(true);
  });

  it('false for canceled / past_due / paused statuses', () => {
    for (const status of ['canceled', 'past_due', 'paused', 'incomplete', 'unpaid']) {
      expect(
        membershipIsActive({ status, current_period_end: NOW + 999_999 }, NOW),
      ).toBe(false);
    }
  });

  it('true for trialing within the period', () => {
    expect(
      membershipIsActive({ status: 'trialing', current_period_end: NOW + 60 }, NOW),
    ).toBe(true);
  });
});

// In-memory D1 stub good enough to verify applyStripeEvent's UPSERT path.
// We model `channel_memberships` as a Map keyed by stripe_subscription_id
// so the ON CONFLICT branch lights up on a second insert with the same id.
function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();

  function exec(sql: string, params: unknown[]): void {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    if (trimmed.startsWith('INSERT INTO channel_memberships')) {
      const isOnConflictUpdate = trimmed.includes('ON CONFLICT(stripe_subscription_id) DO UPDATE');
      if (isOnConflictUpdate) {
        const [
          id,
          memberUserId,
          channelUserId,
          tierId,
          status,
          periodEnd,
          customerId,
          subId,
        ] = params as [string, string, string, string, string, number | null, string | null, string];
        const existing = rows.get(subId);
        if (existing) {
          rows.set(subId, {
            ...existing,
            status,
            current_period_end: periodEnd,
            stripe_customer_id: customerId,
            tier_id: tierId,
          });
        } else {
          rows.set(subId, {
            id,
            member_user_id: memberUserId,
            channel_user_id: channelUserId,
            tier_id: tierId,
            status,
            current_period_end: periodEnd,
            stripe_customer_id: customerId,
            stripe_subscription_id: subId,
          });
        }
        return;
      }
      // checkout.session.completed branch: ON CONFLICT DO NOTHING.
      // Status is hardcoded as 'incomplete' in the SQL VALUES, so the
      // bound params are [id, memberUserId, channelUserId, tierId, subId, customerId].
      const [
        id,
        memberUserId,
        channelUserId,
        tierId,
        subId,
        customerId,
      ] = params as [string, string, string, string, string, string | null];
      if (!rows.has(subId)) {
        rows.set(subId, {
          id,
          member_user_id: memberUserId,
          channel_user_id: channelUserId,
          tier_id: tierId,
          status: 'incomplete',
          current_period_end: null,
          stripe_customer_id: customerId,
          stripe_subscription_id: subId,
        });
      }
    }
  }

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...v: unknown[]) {
          bound = v;
          return this;
        },
        async run() {
          exec(sql, bound);
          return { success: true };
        },
        async first() {
          return null;
        },
      };
    },
    _rows: rows,
  } as unknown as D1Database & { _rows: Map<string, Record<string, unknown>> };
  return db;
}

describe('applyStripeEvent', () => {
  it('upserts on customer.subscription.created with metadata', async () => {
    const db = fakeDb();
    const sub = {
      id: 'sub_123',
      status: 'active',
      customer: 'cus_abc',
      current_period_end: 1_800_000_000,
      metadata: {
        spooool_member_user_id: 'u1',
        spooool_channel_user_id: 'c1',
        spooool_tier_id: 't1',
      },
    } as unknown as Stripe.Subscription;
    const event = {
      type: 'customer.subscription.created',
      data: { object: sub },
    } as unknown as Stripe.Event;

    await applyStripeEvent(db, event);
    const row = db._rows.get('sub_123');
    expect(row).toBeDefined();
    expect(row?.member_user_id).toBe('u1');
    expect(row?.channel_user_id).toBe('c1');
    expect(row?.tier_id).toBe('t1');
    expect(row?.status).toBe('active');
    expect(row?.current_period_end).toBe(1_800_000_000);
  });

  it('overwrites status on a subsequent customer.subscription.updated', async () => {
    const db = fakeDb();
    const base = {
      id: 'sub_123',
      customer: 'cus_abc',
      current_period_end: 1_800_000_000,
      metadata: {
        spooool_member_user_id: 'u1',
        spooool_channel_user_id: 'c1',
        spooool_tier_id: 't1',
      },
    };
    const created = {
      type: 'customer.subscription.created',
      data: { object: { ...base, status: 'active' } as unknown as Stripe.Subscription },
    } as unknown as Stripe.Event;
    const cancelled = {
      type: 'customer.subscription.updated',
      data: { object: { ...base, status: 'canceled' } as unknown as Stripe.Subscription },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, created);
    await applyStripeEvent(db, cancelled);
    expect(db._rows.get('sub_123')?.status).toBe('canceled');
  });

  it('skips subscription events without spooool metadata', async () => {
    const db = fakeDb();
    const sub = {
      id: 'sub_no_meta',
      status: 'active',
      customer: 'cus_abc',
      current_period_end: 1_800_000_000,
      metadata: {},
    } as unknown as Stripe.Subscription;
    const event = {
      type: 'customer.subscription.created',
      data: { object: sub },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, event);
    expect(db._rows.size).toBe(0);
  });

  it('handles checkout.session.completed by inserting an incomplete row when subscription event is delayed', async () => {
    const db = fakeDb();
    const session = {
      mode: 'subscription',
      subscription: 'sub_456',
      customer: 'cus_xyz',
      client_reference_id: 'u2',
      metadata: {
        spooool_member_user_id: 'u2',
        spooool_channel_user_id: 'c2',
        spooool_tier_id: 't2',
      },
    } as unknown as Stripe.Checkout.Session;
    const event = {
      type: 'checkout.session.completed',
      data: { object: session },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, event);
    const row = db._rows.get('sub_456');
    expect(row?.status).toBe('incomplete');
    expect(row?.member_user_id).toBe('u2');
  });

  it('ignores unrelated event types', async () => {
    const db = fakeDb();
    const event = {
      type: 'invoice.created',
      data: { object: {} },
    } as unknown as Stripe.Event;
    await applyStripeEvent(db, event);
    expect(db._rows.size).toBe(0);
  });
});
