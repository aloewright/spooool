# Cloudflare Stream usage in spooool

Reference for agents. Captures the *applied* shape of Cloudflare Stream
in this codebase — which subdomain, which binding, which endpoints,
which pitfalls — so any agent can wire up new Stream features without
re-reading the full upstream docs.

When CF behavior diverges from what's here, the upstream source
(<https://developers.cloudflare.com/stream/>) wins; update this doc.

---

## Account constants

| Field | Value |
|-------|-------|
| Cloudflare account id | `85d376fc54617bcb57185547f08e528b` |
| Stream customer subdomain | `customer-od6lvjm5bwfl1lki.cloudflarestream.com` |
| Workers Stream binding | `[stream] binding = "STREAM"` (wired in `wrangler.toml`) |
| API token (server-side only) | `CF_STREAM_API_TOKEN` worker secret (kept off the client) |
| Webhook signing secret | `CF_STREAM_WEBHOOK_SECRET` worker secret |

The customer subdomain is the modern playback / thumbnail / iframe
origin. `videodelivery.net` is the legacy domain and may be retired.
**Always use the customer subdomain for new code.**

---

## What we use Stream for

1. **Direct creator uploads** — browsers POST files straight to Stream
   via a one-time URL minted by `POST /api/stream/upload-url`
   (`src/workers/stream-upload.ts`). No API token ever reaches the
   client; we use the `[stream]` binding's `createDirectUpload()`.
2. **Recorder pipeline output** — the render container writes MP4s to
   R2, and the existing encoding queue (`src/workers/encoding.ts`)
   uploads them into Stream and stamps `videos.stream_video_id`.
3. **Playback** — Watch.tsx serves the HLS manifest from the customer
   subdomain when `videos.stream_video_id` is populated and the video
   has reached `status='ready'`. R2 is the fallback for non-Stream
   videos.

---

## Direct creator uploads (`/api/stream/upload-url`)

Canonical implementation: **`src/workers/stream-upload.ts`** (+ tests
in `stream-upload.test.ts`). Mounted from `src/workers/index.ts`.

Flow:

```text
client (logged-in user)
  └──> POST /api/stream/upload-url { maxDurationSeconds?, requireSignedURLs?, meta? }
        └──> worker auth + email-verified + rate-limit gates
              └──> env.STREAM.createDirectUpload({
                     maxDurationSeconds,
                     creator: user.id,
                     meta: { ...userMeta, spooool_user_id, spooool_source },
                     allowedOrigins: ['spooool.com', 'www.spooool.com', '*.workers.dev'],
                     requireSignedURLs,
                   })
              <── { uid, uploadURL, customerHost }
        <── { uid, uploadURL, customerHost }
  └──> POST uploadURL  (multipart/form-data, file= field)
```

Best-practice settings we always apply:

- `creator: user.id` — Stream Analytics + per-creator filtering.
- `meta.spooool_user_id`, `meta.spooool_source` — survive even if the
  client supplies its own `meta` keys (we shallow-merge under).
- `allowedOrigins` — locks playback origins to ours; prevents
  hot-linking.
- Hard cap `maxDurationSeconds <= 30 minutes` enforced by the Zod
  schema in `bodySchema`.

Rate-limit bucket: `UPLOAD_INIT_BUCKET` (20 mints/hour/user, shared
with the R2 multipart upload path).

### Basic POST vs tus

- **< 200 MB and reliable connection** — basic POST is enough.
  `createDirectUpload()` returns a single-use POST URL.
- **> 200 MB or unreliable connection** — must use **tus**. The
  Workers binding does not currently mint tus URLs; you have to call
  the REST API (`POST .../stream?direct_user=true`) with
  `Tus-Resumable`, `Upload-Length`, `Upload-Metadata` headers.
  Implement this only when we need it; not in v1.

Recommended client tus library: **Uppy**
(<https://uppy.io/>) — handles chunking, retries, progress.

---

## Playback URLs

Always build URLs from the customer subdomain. Substitute `<UID>` for
`stream_video_id` (or a signed token for private videos).

| Asset | URL |
|-------|-----|
| HLS manifest | `https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<UID>/manifest/video.m3u8` |
| DASH manifest | `https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<UID>/manifest/video.mpd` |
| Stream Player iframe | `https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<UID>/iframe` |
| Thumbnail JPEG (on-the-fly) | `https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<UID>/thumbnails/thumbnail.jpg?time=5s&height=270` |
| Animated GIF thumbnail | `.../thumbnails/thumbnail.gif?time=1s&height=200&duration=4s` |
| MP4 download (must enable first via `POST .../downloads`) | `.../downloads/default.mp4` |
| M4A audio download | `.../downloads/audio.m4a` |

Thumbnail query params: `time` (e.g. `5s`, `1m30s`), `height`, `width`,
`fit` (`crop` / `clip` / `scale` / `fill`). For GIFs also `duration`
and `fps`.

### Where the customer subdomain is hardcoded

| File | Use |
|------|-----|
| `src/workers/thumbnails.ts` (`STREAM_CUSTOMER_HOST` const) | thumbnail candidates |
| `src/frontend/pages/Watch.tsx:107` | HLS manifest for video.js |
| `src/workers/stream-upload.ts` | echoed back to client as `customerHost` |

If you ever need to change the subdomain, grep for
`customer-od6lvjm5bwfl1lki.cloudflarestream.com` and update everywhere.
We deliberately hardcode it instead of using a binding — it's a
per-account constant and an env var would be one more thing to misset.

---

## Signed URLs (private videos)

We do not yet require signed URLs by default. The
`/api/stream/upload-url` route exposes `requireSignedURLs: true` as a
per-call opt-in for callers that need privacy.

When a video has `requireSignedURLs=true`, **any** UID-based URL
(player iframe, manifests, thumbnails, downloads) returns 401 unless a
signed token is substituted for the UID.

### Three ways to mint tokens, ranked by what we should reach for

1. **`env.STREAM.video(uid).generateToken()`** — Workers binding, no
   API call, no key management. 1-hour TTL, no customization. Use this
   unless you need access rules or longer TTL.
2. **`POST /accounts/{acct}/stream/{uid}/token`** — REST endpoint that
   accepts `exp`, `downloadable`, `accessRules`. Rate-limited; use for
   < 1k tokens/day.
3. **Signing key (`POST /stream/keys` once)** — for high-volume or
   custom claims. We don't use this yet; if/when we do, store the
   `jwk` value as a worker secret and self-sign with `crypto.subtle`
   (`RSASSA-PKCS1-v1_5` / `SHA-256`). Worker source for self-signing is
   in the upstream docs (Securing your Stream → Option 3, Step 2).

### Supported claims

| Claim | Meaning |
|-------|---------|
| `exp` | UNIX expiry, max +24 h from sign time |
| `nbf` | Not-before UNIX timestamp |
| `downloadable` | If true, allows MP4/M4A download via this token |
| `accessRules` | Up to 5 IP / geo allow/block rules, evaluated in order |

`accessRules` types: `any`, `ip.src` (CIDR list), `ip.geoip.country`
(ISO 3166-1 alpha-2 list). Actions: `allow`, `block`. Always end with
a default `{ type: 'any', action: 'block' }` if you want a deny-by-
default policy.

### Substituting the token

The token replaces the UID in every URL — including manifests and
thumbnails. There is no separate query param.

```text
https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<TOKEN>/manifest/video.m3u8
https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<TOKEN>/iframe
```

---

## Hotlinking protection (`allowedOrigins`)

Separate from signed URLs. Restricts which origins may load the player
iframe or fetch HLS/DASH segments — even from a custom player.

We set `allowedOrigins` on every direct upload to:
`['spooool.com', 'www.spooool.com', '*.workers.dev']`.

Wildcard rules:

- `*.example.com` matches subdomains but **not** the apex `example.com`.
- `localhost` requires a port unless served over default 80/443.
- No path support; `example.com` covers all paths.

Update an existing video's origins via the binding:
`env.STREAM.video(uid).update({ allowedOrigins: [...] })`.

---

## Stream Player iframe

Embed:

```html
<iframe
  src="https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/<UID>/iframe"
  style="border: none"
  height="720" width="1280"
  allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
  allowfullscreen="true"
></iframe>
<script src="https://embed.cloudflarestream.com/embed/sdk.latest.js"></script>
```

Player API methods: `.play()`, `.pause()`. Properties:
`autoplay`, `controls`, `currentTime`, `duration` (readonly), `ended`
(readonly), `loop`, `muted`, `paused` (readonly), `played`,
`preload`, `volume`, `primaryColor`, `letterboxColor`.

Standard HTML media events fire (`play`, `pause`, `timeupdate`, etc.)
plus three CF-specific `stream-adstart` / `stream-adend` /
`stream-adtimeout`.

Query-string player options (use in the iframe `src`):

| Option | Notes |
|--------|-------|
| `autoplay` | Browsers block autoplay-with-audio; pair with `muted=true` |
| `muted` | Required for autoplay on mobile |
| `controls` | Default `true` |
| `loop`, `preload`, `defaultTextTrack` | Standard semantics |
| `poster` (URL-encoded) | Override default poster image |
| `primaryColor`, `letterboxColor` (URL-encoded CSS color) | UI accent + letterbox fill |
| `startTime` | `123` (seconds) or `1h12m27s` |
| `ad-url` (URL-encoded VAST URI) | Inject pre-roll ads |

We currently use video.js (per the Strand theme + memory) and
**only** substitute the Stream HLS manifest URL into our existing
player. We do not yet render the Stream Player iframe; see "PR 2"
in the conversation history for the planned switch.

---

## Webhooks

Set the notification URL once via `PUT /accounts/{acct}/stream/webhook`.
The response includes a `secret` — store it as `CF_STREAM_WEBHOOK_SECRET`
and use it to verify each request's `Webhook-Signature` header (HMAC
SHA-256 over `<unix-time>.<raw-body>`).

Implementation: **`src/workers/stream-webhook.ts`**.

Events fire when a video finishes processing (on-demand) or when a
live input connects / disconnects / errors. Payload includes
`uid`, `readyToStream`, `status.state`, `status.errorReasonCode`.

Error reason codes worth handling:

- `ERR_NON_VIDEO` — upload wasn't a video
- `ERR_DURATION_EXCEED_CONSTRAINT` — beyond the upload's `maxDurationSeconds`
- `ERR_FETCH_ORIGIN_ERROR` — failed link-based upload
- `ERR_MALFORMED_VIDEO` — corrupt/unrecoverable
- `ERR_DURATION_TOO_SHORT` — < 0.1 s
- `ERR_UNKNOWN`

For local development the upstream docs recommend `cloudflared tunnel
--url http://localhost:8787` since Stream can't POST to localhost.
A worked example lives at <https://developers.cloudflare.com/stream/examples/test-webhooks-locally/>.

---

## MP4 / M4A downloads

Two steps:

1. `POST /accounts/{acct}/stream/{uid}/downloads` (or `/downloads/audio`
   for M4A). Returns `{ status: 'inprogress', url, percentComplete }`.
2. Poll `GET .../downloads` until `status === 'ready'`, then serve the
   URL.

Workers binding shortcut:
`env.STREAM.video(uid).downloads.generate()` (default = MP4) or
`.generate('audio')`. Inspect with `.downloads.get()`.

Append `?filename=foo.mp4` to override the filename in the
`Content-Disposition` header (≤ 120 chars, `[a-zA-Z0-9-_]`).

For **private videos**, the generated download URL still 401s unless
the token has `downloadable: true` set.

---

## Live streaming

Not yet wired into the spooool worker, but worth knowing:

- `POST /accounts/{acct}/stream/live_inputs` returns RTMPS URL +
  stream key. Set `recording.mode = 'automatic'` to auto-record.
- Watch via `customer-...cloudflarestream.com/<INPUT_UID|VIDEO_UID>/iframe`
  or HLS manifest.
- `?dvrEnabled=true` query param turns on rewind/scrub for the player
  or HLS manifest.
- Per-broadcast viewer count: `GET .../views` → `{ liveViewers }`.
- Live Webhooks notify on `live_input.connected` /
  `live_input.disconnected` / `live_input.errored` (set up separately
  from on-demand webhooks).
- WebRTC (WHIP for publish, WHEP for play) gives sub-second latency
  and is currently in open beta. Recording / simulcasting / live
  viewer counts are not yet supported for WebRTC.

---

## Common pitfalls

1. **`videodelivery.net` everywhere** — legacy domain. CSP rules and
   analytics break when we mix it with the customer subdomain. Grep
   periodically; default to `customer-od6lvjm5bwfl1lki.cloudflarestream.com`.
2. **Using REST API tokens client-side** — never. Either the
   `[stream]` binding, or `POST /api/stream/upload-url` followed by
   the one-time URL, or signed-URL tokens. The raw `CF_STREAM_API_TOKEN`
   must never appear in the SPA bundle.
3. **Forgetting `creator: user.id`** — without it, Stream Analytics
   can't filter per-user and we lose the ability to mass-delete a
   creator's uploads via `DELETE /accounts/{id}/stream?creator=...`.
4. **Setting `requireSignedURLs` without minting tokens** — the player
   will 401. Either leave it off or wire up `generateToken()` in the
   playback path.
5. **Letting users hit Stream's 200 MB basic-POST cap** — anything
   bigger requires tus. Either document the limit in the upload UI or
   plumb the tus REST endpoint in the worker.
6. **Editing CSP without allowlisting the iframe / sdk**. If we ever
   render the Stream Player iframe, add `*.cloudflarestream.com` to
   `frame-src` and `embed.cloudflarestream.com` to `script-src`.
7. **Caching HLS manifests outside Stream** — Stream rolled fragmented
   MP4 segments out 2026-04-13. Old segment refs return 404 after
   2026-05-13. We don't cache manifests in our worker; if that ever
   changes, refresh the cache.

---

## Where to start when adding a Stream feature

1. Workers Binding API reference (`https://developers.cloudflare.com/stream/manage-video-library/bindings/`)
   covers `upload`, `videos.list`, `video(id).update/delete/generateToken`,
   `watermarks`, `captions`, `downloads`. Use the binding first.
2. If the binding doesn't cover the operation (e.g., tus, filtering
   videos by creator in list), fall back to the REST API
   (`https://api.cloudflare.com/client/v4/accounts/{id}/stream/...`)
   with the server-side `CF_STREAM_API_TOKEN`.
3. Always pass `creator`, sensible `allowedOrigins`, and
   `requireSignedURLs` defaults aligned with our policy above.
4. Add a `meta.spooool_*` namespace key so the metadata is greppable
   in the Stream dashboard.
