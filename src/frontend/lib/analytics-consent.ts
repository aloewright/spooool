export const ANALYTICS_CONSENT_CHANGE_EVENT = 'spooool:analytics-consent-changed';

export function signalAnalyticsConsentChange(): void {
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGE_EVENT));
}
