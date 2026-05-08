// ALO-179: stub Privacy Policy page. Real copy is pending legal review;
// the route exists so footer links from the homepage have a real target.

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
