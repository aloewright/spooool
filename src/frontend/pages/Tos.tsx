// ALO-179: stub Terms of Service page. Real copy is pending legal review;
// the route exists so footer links from the homepage have a real target.

export function Tos(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1>Terms of Service</h1>
      <p className="ds-meta">Last updated: pending</p>
      <p>
        These Terms of Service govern your use of spooool. The full terms are
        being finalized — in the meantime, by using the service you agree to
        not upload content you don&apos;t have rights to, to follow applicable
        laws, and to respect other users.
      </p>
      <p>
        Questions: <a href="mailto:hello@spooool.com">hello@spooool.com</a>.
      </p>
    </main>
  );
}
