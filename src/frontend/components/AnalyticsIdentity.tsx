import { useEffect, useRef, useState } from 'react';
import { useSession } from '../lib/auth-client';
import { ANALYTICS_CONSENT_CHANGE_EVENT } from '../lib/analytics-consent';
import { loadAnalytics } from '../lib/analytics-loader';

export function AnalyticsIdentity(): null {
  const { data: session, isPending } = useSession();
  const userId = session?.user?.id;
  const hadAuthenticatedSession = useRef(false);
  const [consentVersion, setConsentVersion] = useState(0);

  useEffect(() => {
    const onConsentChange = (): void => setConsentVersion((version) => version + 1);
    window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onConsentChange);
    return () => window.removeEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, onConsentChange);
  }, []);

  useEffect(() => {
    if (isPending) return;
    let cancelled = false;
    const shouldFullyReset = !userId && hadAuthenticatedSession.current;

    if (userId) {
      hadAuthenticatedSession.current = true;
    } else {
      hadAuthenticatedSession.current = false;
    }

    void loadAnalytics()
      .then(({ identify, initAnalytics, reset, resetPersistedIdentityIfIdentified }) => {
        if (cancelled) return;
        if (userId) identify(userId);
        else if (shouldFullyReset) reset();
        else resetPersistedIdentityIfIdentified();
        if (!cancelled) initAnalytics();
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [consentVersion, isPending, userId]);

  return null;
}
