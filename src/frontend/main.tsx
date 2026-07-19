import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import App from './App';
import { AppErrorFallback } from './components/AppErrorFallback';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN ?? '',
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 0.1,
  enabled: import.meta.env.PROD && Boolean(import.meta.env.VITE_SENTRY_DSN),
});

// ALO-281: a render-time crash anywhere in the lazy route tree would unmount
// everything and leave the viewer staring at a blank page. Sentry.ErrorBoundary
// captures the error (so it still lands in Sentry) and renders the Strand
// fallback instead.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);

// Lazy-load RUM so it never blocks first paint — web-vitals registers its
// observers internally with passive listeners. Errors here must never break
// the app render.
void import('./lib/rum')
  .then(({ startRum }) => startRum())
  .catch(() => undefined);
