import { describe, expect, it } from 'vitest';
import { shouldShowBanner } from './CookieConsent';

describe('shouldShowBanner', () => {
  it('shows the banner only when the visitor is in the EU and has no decision', () => {
    expect(shouldShowBanner({ isEu: true, hasDecision: false })).toBe(true);
  });

  it('hides the banner once a decision has been recorded', () => {
    expect(shouldShowBanner({ isEu: true, hasDecision: true })).toBe(false);
  });

  it('hides the banner for non-EU visitors regardless of decision state', () => {
    expect(shouldShowBanner({ isEu: false, hasDecision: false })).toBe(false);
    expect(shouldShowBanner({ isEu: false, hasDecision: true })).toBe(false);
  });
});
