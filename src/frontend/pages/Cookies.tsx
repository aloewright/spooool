import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  type ConsentRecord,
  LEGAL_VERSIONS,
  clearConsent,
  hasFreshAcceptedConsent,
  readConsent,
  writeConsent,
} from '../lib/legal';

// ALO-179: Cookie Policy page. Doubles as the cookie-settings surface
// linked from the footer ("Cookie settings" → /legal/cookies). The
// settings panel near the bottom lets users revisit their accept/reject
// decision without re-triggering the banner.

export function Cookies(): JSX.Element {
  const [record, setRecord] = useState<ConsentRecord | null>(null);

  useEffect(() => {
    setRecord(readConsent());
  }, []);

  const setChoice = (choice: 'accepted' | 'rejected'): void => {
    setRecord(writeConsent(choice));
  };

  const reset = (): void => {
    clearConsent();
    setRecord(null);
  };

  const accepted = hasFreshAcceptedConsent(record);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h1">Cookie Policy</h1>
        <p className="ds-meta">
          Version {LEGAL_VERSIONS.cookies} · Effective {LEGAL_VERSIONS.cookies}
        </p>
      </header>

      <section className="stack-sm">
        <p>
          This Cookie Policy explains how spooool uses cookies and similar technologies on our
          website. Read together with our <Link to="/legal/privacy">Privacy Policy</Link>, it tells
          you what data is set on your device, why, and how to control it.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">1. What are cookies?</h2>
        <p>
          Cookies are small text files stored on your device by your browser when you visit a
          website. They&rsquo;re commonly used to keep you signed in, remember preferences, and
          measure site usage. Similar technologies — local storage, session storage, IndexedDB —
          work the same way for the purposes of this policy.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">2. Cookies we use</h2>

        <div className="card card--tight stack-sm">
          <h3 style={{ margin: 0 }}>Strictly necessary</h3>
          <p className="ds-meta">
            Required to deliver the Service. These do not require consent under the GDPR / ePrivacy
            Directive.
          </p>
          <ul>
            <li>
              <code>better-auth.session_token</code> — keeps you signed in.
            </li>
            <li>
              <code>spooool.csrf</code> — protects state-changing requests against cross-site
              forgery.
            </li>
            <li>
              <code>spooool.cookie-consent</code> (localStorage) — remembers your cookie choice on
              this page so we don&rsquo;t re-prompt.
            </li>
            <li>
              <code>theme</code> (localStorage) — remembers your light/dark preference.
            </li>
          </ul>
        </div>

        <div className="card card--tight stack-sm">
          <h3 style={{ margin: 0 }}>Functional</h3>
          <p className="ds-meta">Improve your experience but are not strictly required.</p>
          <ul>
            <li>
              <code>spooool.watch-position.*</code> (localStorage) — resumes videos from where you
              left off.
            </li>
          </ul>
        </div>

        <div className="card card--tight stack-sm">
          <h3 style={{ margin: 0 }}>Analytics &amp; performance</h3>
          <p className="ds-meta">
            Help us understand how the Service is used so we can improve it. These are{' '}
            <strong>only set when you accept</strong> cookies — by default we do not load analytics,
            and we honour your browser&rsquo;s Do Not Track signal.
          </p>
          <ul>
            <li>
              <strong>PostHog</strong> — anonymous product analytics (autocapture, page views, video
              play events).
            </li>
            <li>
              <strong>Web Vitals</strong> — aggregate performance telemetry (no IDs, only timing
              buckets).
            </li>
            <li>
              <strong>Sentry</strong> — error tracking; replays mask all inputs.
            </li>
          </ul>
        </div>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">3. Your choices</h2>
        <p>
          If you visit from the European Economic Area or the United Kingdom, we show a consent
          banner on your first visit and do not load analytics until you accept. Outside those
          regions you may still set your preference here at any time.
        </p>
        <p>
          You can also block or delete cookies in your browser settings; however, blocking
          strictly-necessary cookies will sign you out and break parts of the Service.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">4. Cookie settings</h2>
        <div className="card stack-sm">
          <p className="ds-meta">
            {record === null
              ? 'You have not yet made a choice on this device.'
              : record.choice === 'accepted'
                ? `Analytics cookies were accepted on ${formatDate(record.decidedAt)} (policy v${record.version}).`
                : `Analytics cookies were declined on ${formatDate(record.decidedAt)} (policy v${record.version}).`}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => setChoice('accepted')}
              disabled={accepted}
              aria-label="Accept analytics cookies"
            >
              Accept analytics
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setChoice('rejected')}
              disabled={record?.choice === 'rejected' && record.version === LEGAL_VERSIONS.cookies}
              aria-label="Reject analytics cookies"
            >
              Reject analytics
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={reset}
              disabled={record === null}
              aria-label="Clear my cookie preference"
            >
              Clear preference
            </button>
          </div>
          <p className="ds-meta">Changing this setting takes effect on your next page load.</p>
        </div>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">5. Contact</h2>
        <p>
          Questions about this Cookie Policy? Email{' '}
          <a href="mailto:privacy@spooool.com">privacy@spooool.com</a>.
        </p>
      </section>
    </main>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
