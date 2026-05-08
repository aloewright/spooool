import { Link } from 'react-router-dom';
import { LEGAL_VERSIONS } from '../lib/legal';

// ALO-179: DMCA Policy overview. The notice and counter-notice forms live
// at /legal/dmca/submit and /legal/dmca/counter respectively; this page
// explains who to contact, what to include, and what happens after a
// notice is filed.

export function Dmca(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1 className="ds-h1">DMCA Policy</h1>
        <p className="ds-meta">
          Version {LEGAL_VERSIONS.dmca} · Effective {LEGAL_VERSIONS.dmca}
        </p>
      </header>

      <section className="stack-sm">
        <p>
          spooool respects the intellectual property rights of others and expects its users to do
          the same. We respond to clear notices of alleged copyright infringement under the Digital
          Millennium Copyright Act, 17 U.S.C. § 512 (the &ldquo;<strong>DMCA</strong>&rdquo;).
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">1. Designated agent</h2>
        <p>
          Notifications of claimed copyright infringement should be sent to our designated agent:
        </p>
        <p>
          <strong>DMCA Designated Agent</strong>
          <br />
          spooool, c/o Legal
          <br />
          Email: <a href="mailto:dmca@spooool.com">dmca@spooool.com</a>
          <br />
          Or use the online form: <Link to="/legal/dmca/submit">submit a DMCA notice</Link>.
        </p>
        <p className="ds-meta">
          Our designated agent is also registered with the U.S. Copyright Office&rsquo;s DMCA
          directory.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">2. What to include in a notice</h2>
        <p>
          To be effective under 17 U.S.C. § 512(c)(3), your notice must include all of the
          following:
        </p>
        <ol>
          <li>
            A physical or electronic signature of the owner, or person authorised to act on behalf
            of the owner, of the exclusive right that is allegedly infringed;
          </li>
          <li>
            Identification of the copyrighted work claimed to have been infringed (or a
            representative list, if multiple works are covered);
          </li>
          <li>
            Identification of the material that is claimed to be infringing and that is to be
            removed, with information reasonably sufficient to permit us to locate it (a spooool URL
            is best);
          </li>
          <li>
            Information reasonably sufficient to permit us to contact you, such as your address,
            telephone number, and email address;
          </li>
          <li>
            A statement that you have a good-faith belief that use of the material in the manner
            complained of is not authorised by the copyright owner, its agent, or the law; and
          </li>
          <li>
            A statement that the information in the notification is accurate, and under penalty of
            perjury, that you are authorised to act on behalf of the owner.
          </li>
        </ol>
        <p>
          Knowingly making a material misrepresentation that material is infringing may subject you
          to liability under 17 U.S.C. § 512(f).
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">3. What happens after we receive a notice</h2>
        <p>
          When we receive a notice that meets the statutory requirements, we will (a) remove or
          disable access to the material, (b) notify the uploader and forward your notice, and (c)
          keep a record of repeat infringers as required under § 512(i).
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">4. Counter-notification</h2>
        <p>
          If you believe your content was removed by mistake or misidentification, you may submit a
          counter-notice. The counter-notice must include:
        </p>
        <ol>
          <li>your physical or electronic signature;</li>
          <li>
            identification of the material that has been removed and the location at which it
            appeared before removal;
          </li>
          <li>
            a statement under penalty of perjury that you have a good-faith belief the material was
            removed as a result of mistake or misidentification;
          </li>
          <li>
            your name, address, and telephone number; and a statement that you consent to the
            jurisdiction of the federal court for the district in which your address is located (or,
            if outside the United States, of any judicial district in which spooool may be found),
            and that you will accept service of process from the person who provided the original
            notice.
          </li>
        </ol>
        <p>
          You can submit a counter-notice via{' '}
          <Link to="/legal/dmca/counter">the counter-notice form</Link>. If we receive a valid
          counter-notice and the original complainant does not file a court action within 10–14
          business days, we may restore the removed material.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">5. Repeat infringers</h2>
        <p>
          We terminate, in appropriate circumstances, accounts of users who are repeat copyright
          infringers, consistent with § 512(i).
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">6. False claims</h2>
        <p>
          A notice that is false or sent in bad faith may expose the sender to liability under §
          512(f). Please make sure your claim is accurate before submitting.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3">7. Submit a notice</h2>
        <p>
          Use the online form to file a DMCA notice. You will receive a reference number on
          submission and a confirmation by email.
        </p>
        <p>
          <Link to="/legal/dmca/submit">
            <button type="button" className="btn btn--secondary">
              Submit a DMCA notice
            </button>
          </Link>
        </p>
      </section>
    </main>
  );
}
