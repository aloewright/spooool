// ALO-127: creator help center stub. Short, scannable answers to the
// questions that come up in the first hour of using spooool. Deeper guides
// live in /docs (see public/docs) once we have them.

import { Link } from 'react-router-dom';

export function Help(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <header className="stack-sm">
        <h1>Help center</h1>
        <p className="ds-lede">
          Short answers to common questions. Can&apos;t find yours?{' '}
          <a href="mailto:hello@spooool.com">Email us</a>.
        </p>
      </header>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Getting started</h2>
        <details open>
          <summary>How do I upload a video?</summary>
          <p className="ds-meta">
            <Link to="/upload">Upload page</Link> → drop in an MP4, WebM, MOV, or MKV. We
            transcode to HLS in the background; you&apos;ll see a progress indicator on the
            video once encoding starts.
          </p>
        </details>
        <details>
          <summary>What file formats do you accept?</summary>
          <p className="ds-meta">
            MP4, WebM, MOV, MKV. Max 4 GB per upload on Free. We re-encode every upload to HLS
            for adaptive streaming.
          </p>
        </details>
        <details>
          <summary>How do I claim my channel URL?</summary>
          <p className="ds-meta">
            Pick a username at <Link to="/signup">signup</Link>. Your channel lives at
            <code>/channel/&lt;username&gt;</code>. Usernames are first-come, first-served and
            tied to your account.
          </p>
        </details>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Account &amp; billing</h2>
        <details>
          <summary>How do I delete my account?</summary>
          <p className="ds-meta">
            <Link to="/settings/account">Account settings</Link> → Delete account. Cascades
            across your videos, comments, and watch history.
          </p>
        </details>
        <details>
          <summary>Can I export my videos?</summary>
          <p className="ds-meta">
            Yes — your original source files are preserved on Member and Studio plans, and
            downloadable from the channel admin panel. Free uploads keep the HLS rendition
            only.
          </p>
        </details>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Policies</h2>
        <p className="ds-meta">
          <Link to="/legal/tos">Terms of Service</Link> ·{' '}
          <Link to="/legal/privacy">Privacy Policy</Link> ·{' '}
          <Link to="/legal/dmca">DMCA</Link>
        </p>
      </section>
    </main>
  );
}
