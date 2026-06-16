// ALO-179 / E8: full Privacy Policy replacing the "pending" stub.

import type { ReactNode, JSX } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="stack-sm">
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

export function Privacy(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1>Privacy Policy</h1>
        <p className="ds-meta">Last updated: June 15, 2026</p>
      </header>

      <p>
        This Privacy Policy describes how spooool ("we", "us", "our") collects, uses, and shares
        information about you when you use spooool.com (the "Service").
      </p>

      <Section title="1. Information We Collect">
        <p>
          <strong>Account information.</strong> When you register, we collect your name, email
          address, and a hashed password. If you sign in with Google or GitHub we receive only your
          name and email from those providers — we do not receive access to your files,
          repositories, or other data.
        </p>
        <p>
          <strong>Content you publish.</strong> Videos, thumbnails, comments, channel profiles,
          and any other content you upload or post on the Service.
        </p>
        <p>
          <strong>Usage data.</strong> Watch history, likes, subscriptions, search queries, and
          interactions with content. This data is used to personalize your experience (e.g., "Continue
          watching") and to surface trending content.
        </p>
        <p>
          <strong>Analytics.</strong> With your consent, we use PostHog to understand how the
          Service is used. PostHog collects page views, clicks, and session recordings (all
          form input values are masked). You can withhold or withdraw consent at any time using
          the cookie banner or your browser's Do Not Track setting.
        </p>
        <p>
          <strong>Technical data.</strong> Your IP address is used for rate limiting and abuse
          prevention and is not stored beyond the request lifecycle. We collect browser type and
          approximate device information via PostHog (with consent only).
        </p>
      </Section>

      <Section title="2. How We Use Your Information">
        <ul style={{ paddingLeft: 'var(--space-4)', margin: 0 }}>
          <li>To operate the Service — authentication, video storage and streaming, notifications;</li>
          <li>To personalize your experience — watch history, subscriptions, recommendations;</li>
          <li>To communicate with you — transactional emails (email verification, password reset, weekly digest);</li>
          <li>To detect and prevent abuse, spam, and illegal activity;</li>
          <li>To understand how the Service is used and improve it (analytics, with consent).</li>
        </ul>
        <p>We do not sell your personal data. We do not use your data for advertising.</p>
      </Section>

      <Section title="3. Third-Party Services">
        <p>
          <strong>Cloudflare.</strong> We use Cloudflare for hosting, global content delivery,
          video transcoding (Cloudflare Stream), and edge caching. Cloudflare processes request
          data as part of its infrastructure role. See the{' '}
          <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener noreferrer" target="_blank">
            Cloudflare Privacy Policy
          </a>
          .
        </p>
        <p>
          <strong>PostHog.</strong> Analytics and session recording (consent-gated). Data is
          processed per PostHog's data processing agreements. You can opt out at any time.
        </p>
        <p>
          <strong>Polar and Stripe.</strong> If you subscribe to the Creator plan, enable tipping,
          or receive payouts, payment data is processed by Polar and their payment partner Stripe
          under their respective privacy policies. We do not store full card numbers.
        </p>
        <p>
          <strong>Sentry.</strong> We use Sentry for error monitoring. Error reports may include
          stack traces and anonymized context about the page you were on. Input field contents are
          not captured.
        </p>
      </Section>

      <Section title="4. Cookies and Local Storage">
        <p>
          We use <strong>localStorage</strong> (not traditional cookies) to remember your
          preferences such as theme (light/dark), onboarding state, and your analytics consent
          choice. This data never leaves your browser.
        </p>
        <p>
          PostHog sets a <strong>cookie</strong> for cross-session analytics only if you have given
          consent via the cookie banner. We do not use third-party advertising or tracking cookies.
        </p>
      </Section>

      <Section title="5. Your Rights">
        <p>
          <strong>Access and portability.</strong> You can request a copy of the personal data we
          hold about you by emailing{' '}
          <a href="mailto:hello@spooool.com">hello@spooool.com</a>.
        </p>
        <p>
          <strong>Correction.</strong> You can update your display name in Account Settings at any
          time. To correct your email address, contact us.
        </p>
        <p>
          <strong>Deletion.</strong> You can delete your account from Account Settings. Deletion is
          permanent and cascades to your videos, comments, watch history, subscriptions, and account
          records. Deletion completes within 30 days. Some anonymised aggregate data (e.g., total
          view counts aggregated across all users) may be retained.
        </p>
        <p>
          <strong>Opt out of analytics.</strong> Use the cookie banner that appears on first visit,
          or enable Do Not Track in your browser settings.
        </p>
        <p>
          If you are located in the European Economic Area, UK, or Switzerland, you have additional
          rights under the GDPR, including the right to restrict processing and to lodge a complaint
          with your local data protection authority.
        </p>
        <p>
          California residents may have additional rights under the CCPA, including the right to
          know what personal information is collected, to request deletion, and to opt out of sale
          (we do not sell personal information).
        </p>
      </Section>

      <Section title="6. Data Retention">
        <p>
          We retain your account data for as long as your account is active. After account deletion,
          personal data is removed within 30 days. Server logs (used for security and abuse
          prevention) are retained for up to 90 days.
        </p>
      </Section>

      <Section title="7. Children">
        <p>
          The Service is not directed to children under 13. We do not knowingly collect personal
          information from children under 13. If you believe a child under 13 has provided us with
          personal data, contact us and we will delete it promptly.
        </p>
      </Section>

      <Section title="8. Changes to This Policy">
        <p>
          We may update this Privacy Policy from time to time. Material changes will be communicated
          by email to your registered address. The "Last updated" date at the top of this page
          reflects the most recent revision.
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Privacy questions, data requests, or concerns:{' '}
          <a href="mailto:hello@spooool.com">hello@spooool.com</a>
        </p>
      </Section>
    </main>
  );
}
