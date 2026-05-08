import { Link } from 'react-router-dom';
import { LEGAL_VERSIONS } from '../lib/legal';

// ALO-179: Terms of Service. Counsel-reviewed first draft. Version stamped
// from `LEGAL_VERSIONS.tos`; bump that constant whenever the substantive
// text changes so the footer "Last updated" line and any future re-consent
// gates stay in sync.

export function Tos(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h1">Terms of Service</h1>
        <p className="ds-meta">
          Version {LEGAL_VERSIONS.tos} · Effective {LEGAL_VERSIONS.tos}
        </p>
      </header>

      <section className="stack-sm">
        <p>
          These Terms of Service (&ldquo;<strong>Terms</strong>&rdquo;) are a binding agreement
          between you and spooool (&ldquo;<strong>spooool</strong>&rdquo;, &ldquo;
          <strong>we</strong>&rdquo;, &ldquo;<strong>us</strong>&rdquo;) governing your access to
          and use of the spooool website, applications, and APIs (collectively, the &ldquo;
          <strong>Service</strong>&rdquo;). By creating an account, uploading content, or otherwise
          using the Service, you agree to these Terms.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">1. Eligibility</h2>
        <p>
          You must be at least 13 years old (or the minimum age of digital consent in your
          jurisdiction, whichever is higher) to use the Service. By using the Service, you represent
          that you meet this requirement and that you have the legal capacity to enter into these
          Terms.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">2. Your account</h2>
        <p>
          You are responsible for activity that occurs under your account and for keeping your
          credentials secure. Notify us at{' '}
          <a href="mailto:security@spooool.com">security@spooool.com</a> if you suspect unauthorised
          access. We may suspend or terminate accounts that violate these Terms.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">3. Your content</h2>
        <p>
          You retain ownership of the videos, comments, and other material you upload (&ldquo;
          <strong>Your Content</strong>&rdquo;). By making Your Content available through the
          Service, you grant spooool a worldwide, non-exclusive, royalty-free licence to host,
          store, reproduce, transcode, distribute, and display Your Content solely for the purpose
          of operating, providing, and improving the Service.
        </p>
        <p>
          You represent and warrant that you own or have all necessary rights to Your Content and
          that Your Content does not infringe any third party&rsquo;s rights or violate any law.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">4. Acceptable use</h2>
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>upload content you do not have the right to share;</li>
          <li>
            post material that is unlawful, defamatory, harassing, sexually exploitative of minors,
            or that incites violence;
          </li>
          <li>
            attempt to circumvent rate limits, scrape the Service, reverse engineer the platform, or
            interfere with other users;
          </li>
          <li>distribute malware or spam, or impersonate another person; or</li>
          <li>use the Service to develop a competing product without our written permission.</li>
        </ul>
        <p>
          We may remove content and suspend accounts that violate this section, with or without
          notice depending on severity.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">5. Copyright and DMCA</h2>
        <p>
          spooool responds to notices of alleged copyright infringement under the Digital Millennium
          Copyright Act. See our <Link to="/legal/dmca">DMCA Policy</Link> for how to submit a
          notice or counter-notice.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">6. Termination</h2>
        <p>
          You may delete your account at any time from{' '}
          <Link to="/settings/account">Account settings</Link>. We may suspend or terminate your
          access if you breach these Terms or if continued access poses a legal or security risk to
          spooool or its users. Sections that by their nature should survive termination — including
          ownership, warranty disclaimers, indemnity, and limitations of liability — will survive.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">7. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
          WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. We do not warrant
          that the Service will be uninterrupted, secure, or error-free.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">8. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, SPOOOOL WILL NOT BE LIABLE FOR INDIRECT,
          INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUES,
          DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH THE SERVICE. OUR AGGREGATE
          LIABILITY FOR ANY CLAIM ARISING OUT OF THESE TERMS WILL NOT EXCEED THE GREATER OF (a) USD
          $100 OR (b) THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AROSE.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">9. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. The version string at the top of this page
          (currently {LEGAL_VERSIONS.tos}) increases when we make material changes. Continued use of
          the Service after the effective date constitutes acceptance of the updated Terms.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">10. Governing law</h2>
        <p>
          These Terms are governed by the laws of the State of California, excluding its
          conflict-of-laws rules. The exclusive venue for any dispute that is not subject to
          arbitration is the state and federal courts located in San Francisco County, California.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">11. Contact</h2>
        <p>
          Questions about these Terms can be sent to{' '}
          <a href="mailto:legal@spooool.com">legal@spooool.com</a>.
        </p>
      </section>
    </main>
  );
}
