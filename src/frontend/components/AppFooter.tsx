import { Link } from 'react-router-dom';

// ALO-179: site-wide footer. Linked from the homepage previously; now
// rendered by `App` so legal links are reachable from every route.

export function AppFooter(): JSX.Element {
  return (
    <footer className="app-footer ds-meta" aria-label="Site footer">
      <nav className="app-footer__nav" aria-label="Legal">
        <Link to="/legal/tos">Terms of Service</Link>
        <Link to="/legal/privacy">Privacy Policy</Link>
        <Link to="/legal/cookies">Cookie Policy</Link>
        <Link to="/legal/dmca">DMCA</Link>
      </nav>
      <div className="app-footer__copy">
        © {new Date().getFullYear()} spooool · Built on Cloudflare
      </div>
    </footer>
  );
}
