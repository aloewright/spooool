import { afterEach, describe, expect, it, vi } from 'vitest';

const { reset, signOut } = vi.hoisted(() => ({
  reset: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./analytics', () => ({ reset }));
vi.mock('./auth-client', () => ({ signOut }));

import { signOutWithAnalyticsReset } from './auth-signout';

describe('signOutWithAnalyticsReset', () => {
  afterEach(() => {
    vi.clearAllMocks();
    signOut.mockResolvedValue(undefined);
  });

  it('resets analytics before Better Auth signs out', async () => {
    const order: string[] = [];
    reset.mockImplementation(() => order.push('reset'));
    signOut.mockImplementation(async () => { order.push('signOut'); });

    await signOutWithAnalyticsReset();

    expect(order).toEqual(['reset', 'signOut']);
  });

  it('still signs out when analytics reset fails', async () => {
    reset.mockImplementation(() => { throw new Error('analytics unavailable'); });

    await signOutWithAnalyticsReset();

    expect(signOut).toHaveBeenCalledOnce();
  });
});
