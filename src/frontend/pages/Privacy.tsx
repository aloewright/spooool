import { Link } from 'react-router-dom';
import { LEGAL_VERSIONS } from '../lib/legal';

// ALO-179: Privacy Policy. Counsel-reviewed first draft. Bumping
// `LEGAL_VERSIONS.privacy` is the canonical signal that the substantive
// text has changed.

export function Privacy(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h1">Privacy Policy</h1>
        <p className="ds-meta">
          Version {LEGAL_VERSIONS.privacy} · Effective {LEGAL_VERSIONS.privacy}
        </p>
      </header>

      <section className="stack-sm">
        <p>
          This Privacy Policy explains what information spooool (&ldquo;<strong>spooool</strong>
          &rdquo;, &ldquo;<strong>we</strong>&rdquo;, &ldquo;<strong>us</strong>&rdquo;) collects
          when you use our service, how we use it, who we share it with, and the choices you have.
          It applies to the spooool website, applications, and APIs (collectively, the &ldquo;
          <strong>Service</strong>&rdquo;).
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">1. Information we collect</h2>
        <h3 className="ds-h3" style={{ fontSize: 'var(--text-lg)' }}>
          a. You give it to us
        </h3>
        <ul>
          <li>
            <strong>Account data</strong> — email address, display name, and password hash (we never
            see your plaintext password).
          </li>
          <li>
            <strong>Content</strong> — the videos, thumbnails, descriptions, tags, comments, and
            channel metadata you upload.
          </li>
          <li>
            <strong>Support correspondence</strong> — anything you send us by email or through a
            support form.
          </li>
        </ul>

        <h3 className="ds-h3" style={{ fontSize: 'var(--text-lg)' }}>
          b. Collected automatically
        </h3>
        <ul>
          <li>
            <strong>Server logs</strong> — IP address, user-agent, request paths, and timestamps.
            Used to operate the Service and detect abuse. Retained for up to 30 days.
          </li>
          <li>
            <strong>Usage analytics</strong> — page views, video play events, and other anonymous
            interaction signals, only when analytics is enabled (see{' '}
            <Link to="/legal/cookies">Cookie Policy</Link>).
          </li>
          <li>
            <strong>Performance telemetry</strong> — aggregate Web Vitals and error reports used to
            keep the site fast and bug-free.
          </li>
        </ul>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">2. How we use information</h2>
        <ul>
          <li>To provide, maintain, and improve the Service.</li>
          <li>
            To authenticate you, secure your account, and detect or prevent fraud, abuse, or
            security incidents.
          </li>
          <li>
            To send you operational email — verification, password resets, DMCA correspondence,
            deletion confirmations, and security notices. We use{' '}
            <a href="https://resend.com" target="_blank" rel="noopener noreferrer">
              Resend
            </a>{' '}
            as our transactional email processor.
          </li>
          <li>To comply with legal obligations and enforce our Terms.</li>
        </ul>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">3. Legal bases (EEA / UK)</h2>
        <p>
          If you are in the European Economic Area or the United Kingdom, we process your personal
          data on the following legal bases under the GDPR / UK GDPR:
        </p>
        <ul>
          <li>
            <strong>Contract</strong> — to provide the Service you signed up for (account, uploads,
            playback).
          </li>
          <li>
            <strong>Legitimate interests</strong> — to keep the Service secure, reliable, and free
            from abuse.
          </li>
          <li>
            <strong>Consent</strong> — for non-essential cookies and analytics. You can withdraw
            consent at any time from the cookie settings link in the footer.
          </li>
          <li>
            <strong>Legal obligation</strong> — when we must retain or disclose data to comply with
            applicable law.
          </li>
        </ul>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">4. Sharing</h2>
        <p>We do not sell your personal data. We share information only with:</p>
        <ul>
          <li>
            <strong>Infrastructure providers</strong> — Cloudflare (compute, storage, video, CDN,
            DDoS protection) hosts the Service.
          </li>
          <li>
            <strong>Email delivery</strong> — Resend processes transactional email on our behalf.
          </li>
          <li>
            <strong>Error tracking</strong> — Sentry receives error stack-traces. Inputs in session
            replays are masked.
          </li>
          <li>
            <strong>Product analytics</strong> — PostHog, when enabled, receives event data.
          </li>
          <li>
            <strong>Authorities</strong> — when required to do so by valid legal process.
          </li>
        </ul>
        <p>
          Our processors are bound by data-processing agreements that limit how they may use your
          data.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">5. International transfers</h2>
        <p>
          spooool is operated from the United States and runs on Cloudflare&rsquo;s global edge.
          When personal data is transferred out of the EEA or UK, we rely on Standard Contractual
          Clauses or equivalent transfer mechanisms with our processors.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">6. Retention</h2>
        <p>
          Account and content data is retained while your account is active. When you delete your
          account from <Link to="/settings/account">Account settings</Link>, we soft-delete
          immediately and hard-delete after a 30-day grace window so accidents are recoverable.
          Server logs roll off after 30 days. Email suppression lists are retained as long as
          required to honour unsubscribe requests.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">7. Your rights</h2>
        <p>Depending on where you live, you may have the right to:</p>
        <ul>
          <li>access the personal data we hold about you;</li>
          <li>correct inaccurate data;</li>
          <li>delete your data (right to erasure);</li>
          <li>port your data to another provider;</li>
          <li>
            withdraw consent for analytics cookies (via the cookie settings link in the footer);
          </li>
          <li>lodge a complaint with your local supervisory authority.</li>
        </ul>
        <p>
          To exercise these rights, email{' '}
          <a href="mailto:privacy@spooool.com">privacy@spooool.com</a>. We respond within 30 days.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">8. Children</h2>
        <p>
          The Service is not directed to children under 13 (or the minimum age of digital consent in
          your jurisdiction). We do not knowingly collect personal data from children. If you
          believe we have, please contact us and we will delete it.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">9. Security</h2>
        <p>
          We take reasonable administrative, technical, and physical measures to protect your data,
          including encryption in transit (TLS), encrypted storage, scoped credentials, and audit
          logging. No system is perfectly secure; you can report suspected vulnerabilities to{' '}
          <a href="mailto:security@spooool.com">security@spooool.com</a>.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">10. Changes</h2>
        <p>
          We may update this Privacy Policy. The version string at the top of this page (currently{' '}
          {LEGAL_VERSIONS.privacy}) increases when we make material changes. We will notify
          registered users by email when changes are material.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">11. Contact</h2>
        <p>
          Questions, requests, or complaints can be sent to{' '}
          <a href="mailto:privacy@spooool.com">privacy@spooool.com</a>.
        </p>
      </section>
    </main>
  );
}
