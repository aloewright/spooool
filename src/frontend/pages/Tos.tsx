// ALO-179 / E8: full Terms of Service replacing the "pending" stub.
// These terms govern the spooool video hosting service.

import type { ReactNode, JSX } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="stack-sm">
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

export function Tos(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1>Terms of Service</h1>
        <p className="ds-meta">Last updated: June 15, 2026</p>
      </header>

      <Section title="1. Acceptance">
        <p>
          By creating an account or using spooool.com ("the Service"), you agree to these Terms of
          Service ("Terms"). If you do not agree, do not use the Service. Use of the Service by
          anyone under the age of 13 is prohibited.
        </p>
      </Section>

      <Section title="2. Your Account">
        <p>
          You are responsible for maintaining the confidentiality of your login credentials and for
          all activity that occurs under your account. You may not share your account or create
          accounts to impersonate others. You must provide accurate information when registering and
          keep it up to date.
        </p>
      </Section>

      <Section title="3. Content You Upload">
        <p>
          <strong>Ownership.</strong> You retain all rights to the videos, images, and other
          material you upload or publish ("Your Content").
        </p>
        <p>
          <strong>License to us.</strong> By uploading Your Content, you grant spooool a
          worldwide, non-exclusive, royalty-free license to host, transcode, store, stream, cache,
          and display Your Content solely to operate and improve the Service. This license ends when
          you delete the content or your account.
        </p>
        <p>
          <strong>Your responsibility.</strong> You are solely responsible for Your Content. You
          represent that you own or have all necessary rights to upload it, and that it does not
          infringe any third-party rights or violate any law.
        </p>
      </Section>

      <Section title="4. Prohibited Content and Conduct">
        <p>You may not upload, publish, or facilitate content or conduct that:</p>
        <ul style={{ paddingLeft: 'var(--space-4)', margin: 0 }}>
          <li>Infringes any copyright, trademark, or other intellectual property right;</li>
          <li>
            Is pornographic, sexually explicit, or depicts minors in a sexual manner (zero
            tolerance — immediate termination and referral to law enforcement);
          </li>
          <li>Promotes or facilitates violence, terrorism, self-harm, or illegal activity;</li>
          <li>Harasses, threatens, stalks, or bullies another person;</li>
          <li>
            Constitutes spam, unsolicited advertising, or deceptive schemes;
          </li>
          <li>Spreads deliberate misinformation designed to deceive or cause harm;</li>
          <li>Violates any applicable law or regulation.</li>
        </ul>
        <p>
          We may remove content and suspend or terminate accounts that violate these rules, without
          prior notice and without refund.
        </p>
      </Section>

      <Section title="5. Copyright (DMCA)">
        <p>
          We comply with the Digital Millennium Copyright Act (17 U.S.C. § 512). If you believe
          your copyrighted work has been uploaded without authorization, submit a notice at{' '}
          <a href="/legal/dmca">spooool.com/legal/dmca</a>. Counter-notices must be submitted
          within 14 days of a takedown. Repeat infringers will have their accounts terminated.
        </p>
      </Section>

      <Section title="6. Paid Plans and Billing">
        <p>
          Creator-tier subscriptions are billed monthly. You may cancel at any time; access
          continues until the end of the current billing period. No refunds are issued for
          partial billing periods except as required by applicable law. We reserve the right to
          change pricing with at least 30 days' notice to your registered email address.
        </p>
      </Section>

      <Section title="7. Monetization">
        <p>
          Creator-tier accounts may enable tipping and recurring memberships. We retain a 10%
          platform fee on all payments processed through the Service. Payouts are processed by
          Polar and subject to their terms and payment processor policies. You are responsible for
          any applicable taxes on payments you receive.
        </p>
      </Section>

      <Section title="8. Termination">
        <p>
          You may delete your account at any time from Account Settings; deletion is permanent and
          irreversible. We may suspend or permanently terminate your access for violation of these
          Terms. Upon termination, your content will be deleted pursuant to our Privacy Policy.
          Sections 3 (license survival until deletion), 4, 9, 10, and 11 survive termination.
        </p>
      </Section>

      <Section title="9. Disclaimers">
        <p>
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND,
          EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
          PURPOSE, OR NON-INFRINGEMENT. WE DO NOT GUARANTEE UNINTERRUPTED, SECURE, OR ERROR-FREE
          SERVICE. YOUR USE OF THE SERVICE IS AT YOUR OWN RISK.
        </p>
      </Section>

      <Section title="10. Limitation of Liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, SPOOOOL AND ITS OPERATORS SHALL NOT BE LIABLE
          FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES,
          OR LOSS OF PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM OR RELATED TO YOUR USE OF
          (OR INABILITY TO USE) THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          OUR TOTAL LIABILITY TO YOU FOR ANY CLAIM SHALL NOT EXCEED THE GREATER OF $50 OR THE
          AMOUNT YOU PAID US IN THE TWELVE MONTHS PRECEDING THE CLAIM.
        </p>
      </Section>

      <Section title="11. Governing Law">
        <p>
          These Terms are governed by the laws of the United States. Any dispute arising under or
          related to these Terms shall be resolved in a court of competent jurisdiction. You waive
          any objection to personal jurisdiction or venue in such courts.
        </p>
      </Section>

      <Section title="12. Changes to These Terms">
        <p>
          We may update these Terms at any time. Material changes will be communicated by email or
          a prominent notice on the Service at least 14 days before they take effect. Continued use
          of the Service after the effective date constitutes acceptance of the revised Terms.
        </p>
      </Section>

      <Section title="13. Contact">
        <p>
          Questions about these Terms:{' '}
          <a href="mailto:hello@spooool.com">hello@spooool.com</a>
        </p>
      </Section>
    </main>
  );
}
