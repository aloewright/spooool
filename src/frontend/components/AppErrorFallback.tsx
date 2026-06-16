import type { JSX } from "react";
// ALO-281: render-time crash fallback for the React tree. Wrapped around
// <App /> in main.tsx via <Sentry.ErrorBoundary fallback={...}>. Sentry still
// captures the error; this just keeps the user from staring at a blank page.
//
// Reload (rather than `resetError`) is intentional: a render-level crash
// often means application state is wedged, and a hard navigation is the most
// reliable recovery. We expose `onReload` for tests to inject without
// touching window.location.

export interface AppErrorFallbackProps {
  /** Optional override; defaults to `window.location.reload()`. */
  onReload?: () => void;
}

export function AppErrorFallback({ onReload }: AppErrorFallbackProps = {}): JSX.Element {
  const reload = (): void => {
    if (onReload) {
      onReload();
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  return (
    <main className="app-main app-main--narrow stack" role="alert" aria-live="assertive">
      <section
        className="card stack-sm"
        style={{ padding: 'var(--space-6)', textAlign: 'center' }}
      >
        <h1 className="ds-h2" style={{ margin: 0 }}>Something went wrong</h1>
        <p className="ds-meta">
          The page hit an unexpected error. We&apos;ve logged it; you can try reloading.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 'var(--space-2)' }}>
          <button type="button" className="btn" onClick={reload}>
            Reload
          </button>
        </div>
      </section>
    </main>
  );
}
