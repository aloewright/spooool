# PostHog

Spooool uses the US PostHog Cloud project. The frontend integration is inert unless a production build receives `VITE_POSTHOG_KEY`, and it starts only after explicit cookie consent.

## Source of truth

Store these in Doppler; never commit them:

- `VITE_POSTHOG_KEY` — PostHog project token (`phc_…`)
- `VITE_POSTHOG_HOST` — `https://us.i.posthog.com`

## Synchronize Cloudflare Workers Builds

Workers Builds needs build-time variables because Vite bakes `VITE_*` values into static assets:

```bash
doppler run --project quickapp --config dev -- npm run posthog:sync-build-env
```

The command updates both preview and production triggers without replacing unrelated variables. Re-run it after recreating a Workers Builds trigger or rotating the project token.

## Verification

1. Build production assets with Doppler and confirm the analytics chunk contains the configured host but never log the token.
2. Deploy through the `main` Workers Builds trigger.
3. Open Spooool in a clean browser profile, accept analytics cookies, and navigate between two SPA routes.
4. Confirm `$pageview` events and the stable Better Auth user ID appear in PostHog Live Events.
5. Confirm declining analytics cookies produces no PostHog ingestion requests.
