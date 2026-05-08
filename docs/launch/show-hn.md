# Show HN — primary launch post

**Surface:** Hacker News (`https://news.ycombinator.com/submit`)
**Format:** Show HN
**When:** T-0, Tuesday 09:00 PT
**Account:** `aloewright`

## Title (≤80 chars; HN strips emoji)

```
Show HN: spooool – a self-hosted YouTube alternative that runs entirely on Cloudflare
```

Backup titles if the above gets flagged or feels long:

- `Show HN: spooool – open-source video host on Cloudflare (Workers, R2, Stream, D1)`
- `Show HN: I built a video host on Cloudflare for ~$2/month`

## URL field

`https://github.com/aloewright/spooool`

> Use the repo URL, not the live site. HN's Show-HN convention is to point
> at the project; we drop the live URL into the body where readers expect it.

## Body (paste-ready)

```
spooool is a self-hostable, open-source video host. The core MVP — upload,
HLS playback with adaptive bitrate, channels, comments, search, watch history
— runs entirely on Cloudflare's developer platform: Workers + R2 + Stream + D1
+ Durable Objects + KV. Zero external dependencies for any core path.

Try it: https://spooool.com
Repo:   https://github.com/aloewright/spooool

Why I built it. Existing self-hosted options either need you to babysit a
GPU box (PeerTube, Owncast) or punt encoding to a paid SaaS. I wanted
something where someone with a Cloudflare account, no servers, and a $5/mo
budget could host their own video site at meaningful scale. The numbers
mostly work out — the README has a full cost table; in the small-scale
scenario (100 videos, 10k monthly views) it's $7-15/mo with Stream
encoding, or ~$0.50-2/mo with the R2-only / FFmpeg-in-a-Worker path.

Stack notes for anyone curious:

- Frontend: React 18 SPA in a Worker, hls.js light player + native-player
  fallback (we swapped video.js out — perf was better on iOS).
- Auth: better-auth with email verification + active-session revoke.
- Search: D1 FTS5 with a /suggest typeahead. Recommendations are
  same-channel + title FTS + trending fill.
- Lifecycle: canonical state machine for video processing
  (uploaded → encoding → ready / failed / removed) — caught a bunch of
  half-states the previous ad-hoc flags missed.
- Comments: nested replies, spam filter, full DMCA + moderation queue.
- Storage: per-user quota with a real 413 + machine-readable error code,
  not just a 500.
- All LLM/embedding calls (recs ranking, mod assist) route through one
  Cloudflare AI Gateway endpoint with dynamic routes — never hit a provider
  SDK directly. There's a CI guard that fails the build if anyone sneaks
  one in.

Things I'd love feedback on:

- The R2-only encoding path. It works but FFmpeg in a Worker is unusual
  enough that I'd like outside eyes on the queue + retry shape.
- The cost model. Have I missed an egress trap that bites at, say,
  100k monthly views?
- The "build on one cloud's primitives" tradeoff. I lose portability and
  a Cloudflare-side outage is a hard outage. Open to hearing the case
  against.

Not affiliated with Cloudflare — they're just the only stack where this
math works without a CDN/origin/encoder/db Frankenstein. Happy to answer
questions in-thread.
```

## Pre-post checklist

- [ ] Demo video URL embedded somewhere on the homepage (`coordination.md`
      tracks recording status)
- [ ] Status page green (`https://status.spooool.com`)
- [ ] Oncall ack'd in `#oncall-spooool` Slack
- [ ] D1 backup snapshot taken in last 24h (runbook:
      `docs/runbooks/d1-backup-restore.md`)
- [ ] Rate-limit DO thresholds raised to launch values (`docs/launch/coordination.md` §
      "Pre-flight infra")
- [ ] Sentry release tag matches deployed Worker version
- [ ] `https://spooool.com` loads in a fresh incognito on mobile + desktop

## In-thread playbook

The first 90 minutes determine front-page placement. Plan:

- **Within 5 min:** post the cost-model breakdown as a top-level reply
  to the inevitable "but what about egress" comment. Pre-write it; don't
  freestyle. Draft below.
- **Within 15 min:** answer the inevitable "why not PeerTube" question.
  Honest answer: PeerTube is great if you have a server. spooool exists
  for the no-server case.
- **Don't dunk on competitors.** Mods downweight it; readers also
  downweight it.
- **Disclose AI-Gateway routing if asked.** It's a credible question now.
- **If it goes off-topic into Cloudflare-as-monoculture flamewar:**
  acknowledge the concern honestly (it's real), note the open-source
  repo means anyone can port the storage/db abstractions to S3+Postgres,
  link to a tracked issue, move on.

### Pre-canned replies

**Re: egress / cost surprises**

```
Egress was the first thing I stress-tested because it's the usual gotcha.
The trick is that R2 → Stream is free internal egress, and Stream → viewer
egress is bundled into the per-1000-min-delivered price (no separate
bandwidth bill). In the R2-only path you do pay R2 egress on the way
out, but R2's $0/GB-egress pricing is the whole reason this stack works.
The README cost table walks through 100 videos / 10k monthly views;
I'd be happy to plug in your numbers if you want to sanity-check.
```

**Re: why not PeerTube / Owncast**

```
Both are great if you already have or want a server. spooool is for the
"I want a video host but I do not want to run a box" case. Different
operating model. PeerTube also leans on a federation that's mostly
not what casual creators want; Owncast is single-streamer-focused.
spooool is closer to "host your own YouTube channel" without the
operations overhead.
```

**Re: vendor lock-in / Cloudflare monoculture**

```
Fair concern. The honest answer: yes, this is bet-on-one-cloud. The
storage and DB layers are abstracted enough that a port to S3 + Postgres
+ MediaConvert is mostly mechanical, but I haven't done it. If you want
true portability today, this isn't the project. If you want to run on
Cloudflare specifically, the math is hard to beat.
```

**Re: "is this AI-generated"**

```
No models in the user-facing path beyond a small recs ranker that runs
through Cloudflare's AI Gateway with dynamic routes — same API surface
whether the underlying model is OpenAI, Anthropic, or Workers AI. The
guard rail script in `scripts/check-no-direct-providers.mjs` blocks
anyone from hardcoding a provider in CI.
```

## After the post is live

1. Paste HN URL into `coordination.md` → "Live URLs" → HN
2. Paste HN URL as the last tweet in `x-thread.md` before posting
3. Paste HN URL into Reddit cross-posts ("comments here:" line)
4. Pin in `#launch-spooool` Slack with timestamps
