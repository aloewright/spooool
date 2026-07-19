// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';

const { identify, useSession } = vi.hoisted(() => ({
  identify: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({ identify }));
vi.mock('../lib/auth-client', () => ({ useSession }));

import { AnalyticsIdentity } from './AnalyticsIdentity';

describe('AnalyticsIdentity', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('identifies an authenticated session with the stable user id', async () => {
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalledWith('user-42');
    act(() => root.unmount());
  });

  it('does not identify an anonymous session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
