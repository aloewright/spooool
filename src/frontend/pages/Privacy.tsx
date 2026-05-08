// ALO-179 / ALO-184: stub Privacy Policy page. Real copy is pending legal
// review; the route exists so footer links from the homepage have a real
// target. Notes about product analytics live here so visitors have a
// canonical place to read about what's collected and how to opt out.

export function Privacy(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1>Privacy Policy</h1>
      <p className="ds-meta">Last updated: pending</p>
      <p>
        spooool collects the minimum data needed to run the service: your
        account email, the videos and comments you publish, and basic
        analytics about how you use the site. We do not sell your data.
      </p>
      <h2 className="ds-h3">Product analytics</h2>
      <p>
        We use PostHog to understand which features people use and where
        the experience breaks down — for example, the signup → first
        upload → first watch funnel. By default PostHog ingests data into
        an EU region and we mask form input values in any session
        recordings. We honour the browser <code>Do Not Track</code> signal
        and disable analytics for visitors who have it enabled.
      </p>
      <p>
        You can delete your account at any time from{' '}
        <a href="/settings/account">Account settings</a>; deletion cascades
        across your videos, comments, and contact records.
      </p>
      <p>
        Questions: <a href="mailto:hello@spooool.com">hello@spooool.com</a>.
      </p>
    </main>
  );
}
