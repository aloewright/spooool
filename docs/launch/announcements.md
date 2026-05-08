# Launch announcements (ALO-185)

Coordinated launch copy for spooool — a video host built entirely on Cloudflare. Post in this order on launch day; keep status page and oncall in the loop before each post goes live.

## Pre-launch checklist

- [ ] Status page green; incident comms template ready
- [ ] Oncall paged-in for the launch window (±4 hours either side of HN post)
- [ ] Demo video uploaded to spooool itself (eat our own dog food) + mirror on YouTube as fallback
- [ ] Rate limits / quota warnings reviewed — expect 10–50× normal signup traffic
- [ ] Founders watching `@spooool` mentions, HN thread, Reddit inbox
- [ ] Resend transactional sender warmed; verification emails confirmed deliverable

## 1. Show HN

**Title:** `Show HN: Spooool – a video host on Cloudflare that respects your time`

**Body:**

```
Hi HN — I built spooool because every video site I touched felt designed to keep me there, not to give me what I came for. No autoplay-next, no infinite recommendations, no "you might also like" rail eating half the screen.

It's a small video host built end-to-end on Cloudflare:
- Workers + Pages for the app
- Stream for encoding/playback
- R2 for storage, D1 for metadata, Durable Objects for cache + state
- Better-auth for auth, Resend for transactional email
- All LLM/embedding calls routed through Cloudflare AI Gateway (no direct provider keys)

A few opinions baked in:
- One video per page. No sidebar of recommendations.
- Per-user storage quotas with honest 413s instead of silent failure.
- No tracking pixels in the player. Web Vitals only, on first-party domain.
- A canonical lifecycle state machine for uploads — every video has one observable state.

Demo: <link>
Code: <link>

Happy to go deep on the Cloudflare-only architecture, the AI Gateway guard that fails CI on direct provider calls, or the trade-offs of running auth + email + payments + media on a single edge platform. Roast away.
```

Post timing: Tue/Wed/Thu, 08:00–09:30 PT. Don't ask for upvotes. Reply to every top-level comment within the first 2 hours.

## 2. X (Twitter) launch thread

```
1/ Launching spooool today — a video host that respects your time.

No autoplay-next. No "recommended for you" rail. No dark patterns. Just the video you came for.

Built entirely on @CloudflareDev. Demo + sign-up: <link>

🧵
```

```
2/ The whole stack lives on Cloudflare:

• Workers + Pages — app
• Stream — encoding & playback
• R2 — storage
• D1 — metadata
• Durable Objects — cache + state
• AI Gateway — every model call routed (no direct provider keys)

One vendor. One bill. One latency story.
```

```
3/ Opinionated defaults:

• One video, one page. No sidebar.
• Per-user storage quotas with honest 413s.
• No tracking pixels in the player.
• Canonical upload lifecycle — every video has one observable state.
• Email verification via better-auth + Resend.
```

```
4/ Things I learned building this you might find interesting:

• AI Gateway dynamic routes let me swap models without redeploying
• A CI guard that fails the build on direct OpenAI/Anthropic imports kept the gateway honest
• Durable Objects + D1 is a surprisingly good fit for per-video state
```

```
5/ It's live. Try it: <link>

If you break it, tell me — I'm on call today. Replies open.
```

## 3. r/selfhosted

**Title:** `Spooool – a self-hostable-ish video host built on Cloudflare (no autoplay, no recommendation rail)`

**Body:**

```
Hey r/selfhosted — sharing spooool, a small video host I built that's deployable to your own Cloudflare account in a few commands.

It's not self-hosted in the bare-metal sense, but the entire stack runs in **your** Cloudflare account: your Workers, your R2 bucket, your D1, your Stream subscription. No SaaS middleman, no per-user pricing, no data leaving Cloudflare's edge.

Why you might care:
- One-command deploy via wrangler
- All secrets via Doppler or wrangler secrets — nothing baked in
- Per-user storage quotas, hard limits, no surprise bills
- No tracking, no ads, no recommendation engine
- BYO domain via Cloudflare DNS

Why you might not:
- Cloudflare Stream isn't free — pricing is per-minute-stored + per-minute-delivered
- You're trading "self-hosted on a NAS" for "self-hosted on a hyperscaler"

Repo: <link>
Demo: <link>

Happy to answer questions on cost, lock-in, or migration paths off Cloudflare.
```

## 4. r/CloudFlare

**Title:** `Built a video host entirely on Cloudflare (Workers + Stream + R2 + D1 + DO + AI Gateway) — sharing the architecture`

**Body:**

```
Wanted to share a project that uses pretty much the whole Cloudflare developer platform in one app: spooool, a video host.

Stack:
- **Workers + Pages** — app + API
- **Stream** — video encoding, HLS delivery, thumbnails
- **R2** — original-file storage (pre-Stream ingest, plus a few non-video assets)
- **D1** — metadata, users, lifecycle state
- **Durable Objects** — per-video cache + state coordination
- **AI Gateway** — every LLM/embedding/STT call goes through dynamic routes (`dynamic/text_gen`, `dynamic/ai_embed`, etc.). CI fails on direct provider imports.
- **Better-auth** for auth, **Resend** for transactional email

A few things that worked well:
1. AI Gateway dynamic routes meant zero code changes when I swapped models.
2. Durable Objects as the "source of truth" for in-flight uploads removed a whole class of race conditions.
3. A canonical lifecycle state machine on D1 made every "where is my upload?" support question a one-query answer.

A few sharp edges:
- Stream's per-minute-delivered pricing means you really do need quotas from day one.
- DO + D1 consistency requires care; we treat DO as cache, D1 as authority.

Demo: <link>
Architecture write-up: <link>

Curious what others have built with the full platform.
```

## Demo video

90-second screen recording, no voiceover, captioned:

1. (0:00–0:10) Sign up → email verification arrives
2. (0:10–0:30) Upload a video → lifecycle states transition live
3. (0:30–0:50) Playback — show the empty sidebar, no recommendation rail
4. (0:50–1:10) Storage quota dashboard — show the 413 on overage
5. (1:10–1:30) Cloudflare dashboard — Workers, Stream, R2, D1, AI Gateway tabs all lit up

Host the demo on spooool itself; mirror to YouTube as a fallback link.

## Oncall coordination

- File a calendar block for the launch window; page primary + secondary.
- Pre-stage status page incident draft titled "Investigating elevated signup traffic" — publish only if needed.
- Watch dashboards: Workers errors, Stream ingest queue depth, D1 query p99, R2 4xx rate, AI Gateway error rate.
- If anything goes red: pause posting, post status update, fix forward.

## Post-launch (T+24h)

- Reply to every HN/Reddit top-level comment.
- Pin the best community question to the X thread.
- Write a short retro: traffic, errors, what broke, what didn't.
