import { Hono } from 'hono';
import { videoRoutes, type VideoRoutesEnv } from '../../src/workers/videos';

// Test-only worker entry. Mounts the real videoRoutes with a stub session
// middleware so integration tests can drive the routes without spinning up
// better-auth / Sentry / the rest of the production stack.
//
// Tests authenticate by setting `x-test-user-id`. Email-verification state
// is implied by `x-test-user-email-verified: false` (defaults to verified).

type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
} | null;

type Bindings = VideoRoutesEnv;
type Variables = { user: SessionUser };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', async (c, next) => {
  const id = c.req.header('x-test-user-id');
  const verified = c.req.header('x-test-user-email-verified');
  const user: SessionUser = id
    ? {
        id,
        email: c.req.header('x-test-user-email') ?? `${id}@example.test`,
        name: c.req.header('x-test-user-name') ?? id,
        emailVerified: verified !== 'false',
      }
    : null;
  c.set('user', user);
  await next();
});

app.route('/', videoRoutes);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;
