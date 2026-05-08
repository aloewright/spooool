import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  hasFreshAcceptedConsent,
  isEuCountry,
  readConsent,
  writeConsent,
  LEGAL_VERSIONS,
} from '../lib/legal';

// ALO-179: GDPR cookie-consent banner. Shown only to visitors whose CF
// edge-resolved country is in the EEA / UK *and* who have not already
// recorded a decision against the current cookie-policy version. Until a
// choice is made, analytics is not initialised (see main.tsx → it waits
// on `loadAnalyticsIfAllowed`).

interface GeoResponse {
  country: string | null;
  isEu: boolean;
}

async function fetchGeo(): Promise<GeoResponse | null> {
  try {
    const res = await fetch('/api/geo', { credentials: 'omit' });
    if (!res.ok) return null;
    const body = (await res.json()) as GeoResponse;
    return body;
  } catch {
    return null;
  }
}

export function shouldShowBanner(args: { isEu: boolean; hasDecision: boolean }): boolean {
  return args.isEu && !args.hasDecision;
}

interface Props {
  /** Test seam: replaces the `/api/geo` fetch. */
  geoFetcher?: () => Promise<GeoResponse | null>;
  /** Test seam: invoked after the user accepts so analytics can boot. */
  onAccept?: () => void;
}

export function CookieConsent({ geoFetcher = fetchGeo, onAccept }: Props): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Existing decision against the current policy version → never show.
    const record = readConsent();
    if (record !== null && record.version === LEGAL_VERSIONS.cookies) {
      return;
    }
    void geoFetcher().then((geo) => {
      if (cancelled) return;
      if (shouldShowBanner({ isEu: isEuCountry(geo?.country), hasDecision: false })) {
        setVisible(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [geoFetcher]);

  if (!visible) return null;

  const accept = (): void => {
    const r = writeConsent('accepted');
    setVisible(false);
    if (hasFreshAcceptedConsent(r)) onAccept?.();
  };

  const reject = (): void => {
    writeConsent('rejected');
    setVisible(false);
  };

  return (
    <div role="dialog" aria-live="polite" aria-label="Cookie consent" className="cookie-consent">
      <div className="cookie-consent__body">
        <p className="ds-meta" style={{ margin: 0 }}>
          We use strictly-necessary cookies to keep you signed in. With your consent, we&rsquo;d
          also like to set analytics cookies to understand how the Service is used. See our{' '}
          <Link to="/legal/cookies">Cookie Policy</Link> for details.
        </p>
        <div className="cookie-consent__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={reject}
            aria-label="Reject analytics cookies"
          >
            Reject
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={accept}
            aria-label="Accept analytics cookies"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
