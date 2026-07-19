// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';

const { identify, loadAnalytics, reset, useSession } = vi.hoisted(() => ({
  identify: vi.fn(),
  loadAnalytics: vi.fn(),
  reset: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('../lib/analytics-loader', () => ({ loadAnalytics }));
vi.mock('../lib/auth-client', () => ({ useSession }));

import { AnalyticsIdentity } from './AnalyticsIdentity';

describe('AnalyticsIdentity', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    loadAnalytics.mockResolvedValue({ identify, reset });
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

  it('waits for session settlement before resetting an expired authenticated session', async () => {
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));
    vi.clearAllMocks();

    useSession.mockReturnValue({ data: null, isPending: true });
    await act(async () => root.render(<AnalyticsIdentity />));
    expect(reset).not.toHaveBeenCalled();

    useSession.mockReturnValue({ data: null, isPending: false });
    await act(async () => root.render(<AnalyticsIdentity />));
    expect(reset).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('cancels a pending identity import when the session expires', async () => {
    let resolveAnalytics: ((value: { identify: typeof identify; reset: typeof reset }) => void) | undefined;
    loadAnalytics
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAnalytics = resolve; }))
      .mockResolvedValueOnce({ identify, reset });
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    act(() => root.render(<AnalyticsIdentity />));
    useSession.mockReturnValue({ data: null, isPending: false });
    act(() => root.render(<AnalyticsIdentity />));
    await act(async () => undefined);

    expect(identify).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();

    resolveAnalytics?.({ identify, reset });
    await act(async () => undefined);
    expect(identify).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
