// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';

const { identify, initAnalytics, loadAnalytics, reset, resetPersistedIdentityIfIdentified, useSession } = vi.hoisted(() => ({
  identify: vi.fn(),
  initAnalytics: vi.fn(),
  loadAnalytics: vi.fn(),
  reset: vi.fn(),
  resetPersistedIdentityIfIdentified: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('../lib/analytics-loader', () => ({ loadAnalytics }));
vi.mock('../lib/auth-client', () => ({ useSession }));

import { AnalyticsIdentity } from './AnalyticsIdentity';
import { ANALYTICS_CONSENT_CHANGE_EVENT } from '../lib/analytics-consent';

describe('AnalyticsIdentity', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    loadAnalytics.mockResolvedValue({ identify, initAnalytics, reset, resetPersistedIdentityIfIdentified });
  });

  it('identifies an authenticated session with the stable user id', async () => {
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalledWith('user-42');
    expect(initAnalytics).toHaveBeenCalledOnce();
    expect(identify.mock.invocationCallOrder[0]).toBeLessThan(initAnalytics.mock.invocationCallOrder[0]);
    act(() => root.unmount());
  });

  it('selectively clears persisted analytics identity on the first settled anonymous session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(resetPersistedIdentityIfIdentified).toHaveBeenCalledOnce();
    expect(initAnalytics).toHaveBeenCalledOnce();
    expect(resetPersistedIdentityIfIdentified.mock.invocationCallOrder[0]).toBeLessThan(
      initAnalytics.mock.invocationCallOrder[0],
    );
    act(() => root.unmount());
  });

  it('does not initialize while a prior identity is awaiting session resolution', async () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));
    expect(loadAnalytics).not.toHaveBeenCalled();
    expect(initAnalytics).not.toHaveBeenCalled();

    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).toHaveBeenCalledWith('user-42');
    expect(identify.mock.invocationCallOrder[0]).toBeLessThan(initAnalytics.mock.invocationCallOrder[0]);
    act(() => root.unmount());
  });

  it('defers a cold expired-session identity check until settlement, before initialization', async () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));
    expect(loadAnalytics).not.toHaveBeenCalled();

    useSession.mockReturnValue({ data: null, isPending: false });
    await act(async () => root.render(<AnalyticsIdentity />));

    expect(resetPersistedIdentityIfIdentified).toHaveBeenCalledOnce();
    expect(resetPersistedIdentityIfIdentified.mock.invocationCallOrder[0]).toBeLessThan(
      initAnalytics.mock.invocationCallOrder[0],
    );
    act(() => root.unmount());
  });

  it('reapplies the unchanged authenticated identity when consent is accepted', async () => {
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));
    vi.clearAllMocks();

    await act(async () => window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGE_EVENT)));

    expect(identify).toHaveBeenCalledWith('user-42');
    expect(initAnalytics).toHaveBeenCalledOnce();
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
    let resolveAnalytics: ((value: {
      identify: typeof identify;
      initAnalytics: typeof initAnalytics;
      reset: typeof reset;
      resetPersistedIdentityIfIdentified: typeof resetPersistedIdentityIfIdentified;
    }) => void) | undefined;
    loadAnalytics
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAnalytics = resolve; }))
      .mockResolvedValueOnce({ identify, initAnalytics, reset, resetPersistedIdentityIfIdentified });
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

    resolveAnalytics?.({ identify, initAnalytics, reset, resetPersistedIdentityIfIdentified });
    await act(async () => undefined);
    expect(identify).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
