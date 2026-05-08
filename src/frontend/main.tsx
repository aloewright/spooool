import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import App from './App';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN ?? '',
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 0.1,
  enabled: import.meta.env.PROD && Boolean(import.meta.env.VITE_SENTRY_DSN),
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Lazy-load RUM so it never blocks first paint — web-vitals registers its
// observers internally with passive listeners. Errors here must never break
// the app render.
void import('./lib/rum').then(({ startRum }) => startRum()).catch(() => undefined);

// ALO-166: lazy-load PostHog as well so it doesn't drag posthog-js (~180KB
// raw / ~60KB gz) into the eager vendor chunk. autocapture / pageview
// timers register on first user interaction, well after the lazy chunk
// arrives.
//
// ALO-179: gated by the cookie-consent record — `initAnalyticsIfAllowed`
// is a no-op when the visitor has rejected analytics. The CookieConsent
// component re-runs this initialiser via its `onAccept` hook the moment
// the user opts in, so EU visitors get analytics from the same
// page-load when they accept.
void import('./lib/analytics')
  .then(({ initAnalyticsIfAllowed }) => initAnalyticsIfAllowed())
  .catch(() => undefined);
