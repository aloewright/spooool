// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const { signalAnalyticsConsentChange, withdrawAnalyticsConsent } = vi.hoisted(() => ({
  signalAnalyticsConsentChange: vi.fn(),
  withdrawAnalyticsConsent: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({ withdrawAnalyticsConsent }));
vi.mock('../lib/analytics-consent', () => ({ signalAnalyticsConsentChange }));

import { CookieBanner } from './CookieBanner';

function click(button: Element | null): void {
  expect(button).not.toBeNull();
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('CookieBanner', () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  it('keeps an accessible way to reopen preferences after a saved choice', async () => {
    window.localStorage.setItem('cookie-consent:v1', 'accepted');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<MemoryRouter><CookieBanner /></MemoryRouter>));
    await act(async () => click(container.querySelector('button[aria-label="Cookie preferences"]')));

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('withdraws initialized analytics when accepted consent is changed to declined', async () => {
    window.localStorage.setItem('cookie-consent:v1', 'accepted');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<MemoryRouter><CookieBanner /></MemoryRouter>));
    await act(async () => click(container.querySelector('button[aria-label="Cookie preferences"]')));
    await act(async () =>
      click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Decline') ?? null),
    );

    expect(window.localStorage.getItem('cookie-consent:v1')).toBe('declined');
    expect(withdrawAnalyticsConsent).toHaveBeenCalledOnce();
    expect(signalAnalyticsConsentChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('allows declined consent to be reaccepted', async () => {
    window.localStorage.setItem('cookie-consent:v1', 'declined');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<MemoryRouter><CookieBanner /></MemoryRouter>));
    await act(async () => click(container.querySelector('button[aria-label="Cookie preferences"]')));
    await act(async () =>
      click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Accept') ?? null),
    );

    expect(window.localStorage.getItem('cookie-consent:v1')).toBe('accepted');
    expect(signalAnalyticsConsentChange).toHaveBeenCalledOnce();
    expect(withdrawAnalyticsConsent).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
