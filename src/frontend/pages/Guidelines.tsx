import type { ReactNode } from 'react';

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="stack-sm">
      <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

export function Guidelines(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1>Community Guidelines</h1>
        <p className="ds-meta">Last updated: July 6, 2026</p>
        <p>
          spooool is a video platform for creators who want to share their work without
          algorithmic noise or corporate interference. To keep it that way, everyone on
          the platform — uploaders and viewers alike — agrees to these guidelines.
        </p>
      </header>

      <Section title="1. Content we welcome">
        <p>
          Original video content of any kind: tutorials, vlogs, short films, gaming, music,
          art, commentary, documentary, comedy, and everything in between. We value creative
          work that is made by real people and shared in good faith.
        </p>
      </Section>

      <Section title="2. Content that is never allowed">
        <p>The following content will be removed and may result in account termination:</p>
        <ul style={{ paddingLeft: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <li>Child sexual abuse material (CSAM) or any sexual content involving minors. We report all such content to NCMEC.</li>
          <li>Content that depicts, promotes, or incites real-world violence or terrorism.</li>
          <li>Doxxing — sharing another person's private information (home address, phone number, etc.) without consent.</li>
          <li>Non-consensual intimate imagery (NCII / "revenge porn").</li>
          <li>Malware, phishing links, or content designed to defraud viewers.</li>
          <li>Impersonating another creator, public figure, or the spooool team in a way intended to deceive.</li>
        </ul>
      </Section>

      <Section title="3. Copyright and intellectual property">
        <p>
          Only upload content you have the right to share. If your video includes third-party
          music, footage, or other copyrighted material, make sure you have a licence or your
          use qualifies as fair use. Rights holders may submit takedown requests under our{' '}
          <a href="/legal/dmca" className="ds-link">DMCA policy</a>.
        </p>
      </Section>

      <Section title="4. Spam and artificial engagement">
        <p>
          Do not use bots, purchased views, or coordinated inauthentic behaviour to inflate
          metrics. Spam comments and mass-reporting campaigns intended to harm other creators
          are prohibited.
        </p>
      </Section>

      <Section title="5. Misleading content">
        <p>
          Don't present synthetic or heavily manipulated content as real without clear
          disclosure. Satire and parody are fine — deception is not.
        </p>
      </Section>

      <Section title="6. Hateful content">
        <p>
          Content that attacks people on the basis of race, ethnicity, national origin,
          religion, gender, sexual orientation, disability, or similar characteristics has
          no place here. Critique of ideas — including political, religious, or cultural
          ideas — is permitted when it doesn't cross into dehumanisation.
        </p>
      </Section>

      <Section title="7. Age-restricted content">
        <p>
          Content that is suitable for adults only (graphic violence, mature themes, explicit
          language) must be marked as age-restricted when uploading. Sexual content is
          restricted to non-explicit depictions only.
        </p>
      </Section>

      <Section title="8. Enforcement">
        <p>
          We review flagged content and act proportionately. Consequences range from content
          removal to temporary suspension to permanent account termination, depending on
          severity and history. Repeat violations will result in account removal.
        </p>
        <p>
          If you believe content was removed in error, or your account was suspended
          incorrectly, contact us at{' '}
          <a href="mailto:trust@spooool.com" className="ds-link">trust@spooool.com</a>.
        </p>
      </Section>

      <Section title="9. Reporting">
        <p>
          Use the report button on any video or comment to flag content that may violate
          these guidelines. We review every report — thank you for helping keep the
          community healthy.
        </p>
      </Section>

      <Section title="10. Changes">
        <p>
          We may update these guidelines as the platform evolves. Significant changes will
          be announced via our status page and, where appropriate, by email. Continued use
          of spooool after an update constitutes acceptance of the revised guidelines.
        </p>
      </Section>

      <p className="ds-meta" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
        These guidelines supplement our{' '}
        <a href="/legal/tos" className="ds-link">Terms of Service</a>
        {' '}and{' '}
        <a href="/legal/privacy" className="ds-link">Privacy Policy</a>.
        For legal notices, see the{' '}
        <a href="/legal/dmca" className="ds-link">DMCA page</a>.
      </p>
    </main>
  );
}
