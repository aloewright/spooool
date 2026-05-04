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
void import('./lib/rum')
  .then(({ startRum }) => startRum())
  .catch(() => undefined);

// ALO-166: lazy-load PostHog as well so it doesn't drag posthog-js (~180KB
// raw / ~60KB gz) into the eager vendor chunk. autocapture / pageview
// timers register on first user interaction, well after the lazy chunk
// arrives.
void import('./lib/analytics')
  .then(({ initAnalytics }) => initAnalytics())
  .catch(() => undefined);
