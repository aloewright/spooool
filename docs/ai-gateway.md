# AI Gateway routing policy

**Every** LLM, embedding, image, audio, speech-to-text, and video-generation
model call in spooool must route through Cloudflare AI Gateway *dynamic
routes*. Direct provider SDKs and hardcoded provider URLs / model ids
bypass caching, rate limits, BYOK virtual keys, observability, cost
routing, and fallbacks — and they hardcode model choice into the
codebase.

## What this means in practice

| Forbidden | Use instead |
|-----------|-------------|
| `import OpenAI from 'openai'` | The Gateway's OpenAI-compat HTTPS endpoint, or `env.AI.run(...)` from a Worker |
| `import Anthropic from '@anthropic-ai/sdk'` | Same — Gateway is OpenAI-compatible |
| `https://api.openai.com/...` | `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/compat/chat/completions` |
| `model: 'openai/gpt-4o'` | `model: 'dynamic/text_gen'` (or `dynamic/research_gen`, `dynamic/ai_embed`, `dynamic/image_gen`, `dynamic/audio_gen`, `dynamic/stt_gen`, `dynamic/video_gen`) |

## Inside a Worker

Prefer the `AI` binding:

```ts
const result = await env.AI.run(
  'dynamic/text_gen',
  { messages: [{ role: 'user', content: prompt }] },
  { gateway: { id: env.CF_GATEWAY_ID ?? 'x' } },
);
```

## From a Node script (no SDK)

```ts
const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID ?? 'x'}/compat/chat/completions`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
    'cf-aig-zdr': 'true',
  },
  body: JSON.stringify({ model: 'dynamic/text_gen', messages: [...] }),
});
```

No provider API key in our codebase, ever.

## Enforcement

- `npm run lint:no-providers` runs `scripts/check-no-direct-providers.mjs`
  which scans `src/`, `scripts/`, and `tests/` for forbidden imports,
  URLs, and model ids. The script runs as part of `npm run lint`, so
  CI fails the PR on any direct call.
- Tests are exempt — `*.test.ts` files may legitimately mock provider
  SDKs.
- The script itself is exempt because it has to reference the patterns
  it forbids.

## Adding a new model surface

When a new feature lands that needs a model call (captions, moderation,
summaries, embeddings for search, image gen for thumbnails, etc.):

1. Pick the right dynamic route from the table above.
2. Wire it through `env.AI.run(...)` from a Worker or the compat HTTPS
   endpoint from a Node script.
3. Surface the response shape consumed by your feature behind a thin
   helper in `src/workers/` so the route slug isn't sprinkled across
   the codebase.
4. Don't add the provider's SDK to `package.json`.

## Audit findings (ALO-191, 2026-05-07)

Audited at the time of writing this doc:

- `src/auth/` — clean. better-auth handles email/password + OAuth state
  via D1, no model calls.
- `src/workers/` — clean. The encoding pipeline calls Cloudflare Stream
  (managed video service, not a model API) and the Loops REST API
  (transactional email, not a model API).
- `package.json` — no `openai`, `@anthropic-ai/sdk`, `replicate`,
  `@ai-sdk/*`, `cohere-ai`, `groq-sdk`, or `@google/generative-ai`
  dependencies.

Result: 0 findings. The guard is in place to keep it that way as
features land.
