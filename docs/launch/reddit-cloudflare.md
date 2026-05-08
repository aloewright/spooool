# Reddit cross-post — r/CloudFlare

**Surface:** [r/CloudFlare](https://www.reddit.com/r/CloudFlare/)
**When:** T-0 + 60 min (after r/selfhosted post is up)
**Flair:** `Showcase` if available, else `Discussion`
**Account:** primary

## Subreddit rules to remember

r/CloudFlare is much smaller than r/selfhosted (~30k vs ~400k) and
the audience skews "I work with Cloudflare professionally." Different
framing required:

1. **Lead with the technical interesting parts**, not the product
   pitch. This community wants to see Workers tricks, R2 patterns,
   Stream gotchas — not another "I made a thing" post.
2. **No "Cloudflare is amazing" gushing.** It reads as astroturfing
   even when sincere.
3. **Mention rough edges.** This audience has hit them. They'll
   trust you more if you've hit them too.
4. **Disclose authorship and that you're not affiliated with
   Cloudflare.** Mods are strict on perceived affiliation claims.

## Title

```
Built a self-hosted YouTube clone entirely on Workers + R2 + Stream + D1 — write-up + open source
```

Backup:

```
Lessons from shipping a video host on Cloudflare's developer platform (Workers/R2/Stream/D1, MIT licensed)
```

## Body (paste-ready)

```
I shipped spooool — an open-source video host built entirely on
Cloudflare. Posting here because the parts that were interesting
to *build* are very different from the parts that are interesting
to use, and I think this audience will care about the build side.

Repo: https://github.com/aloewright/spooool
Live: https://spooool.com
HN thread (general questions there): <HN URL — fill at launch>

Disclosure: I'm the developer. Not affiliated with Cloudflare —
I just couldn't get the math to work anywhere else.

**The interesting bits, technically**

1. **R2 → Stream is internal egress.** This is the unlock. Upload
   to R2, hand the object to Stream, no bandwidth bill on the
   handoff. Without this, the cost story collapses.

2. **R2-only encoding path with FFmpeg-in-a-Worker.** Stream is
   easier but adds per-minute cost. The R2-only path runs FFmpeg
   in a Worker triggered by an R2 event, writes HLS segments back
   to R2, generates the manifest on the fly. ~10× cheaper at the
   cost of having to think about CPU limits and chunked uploads.

3. **D1 + FTS5 for search and recommendations.** Title search is
   FTS5; recommendations are same-channel + title FTS + trending
   fill. No vector DB, no Pinecone, no embedding service for
   day-1. Adding semantic search later is one Vectorize binding
   away — kept off the critical path on purpose.

4. **Durable Objects for rate limiting + channel state.** The
   per-channel DO is the canonical author of "is this video ready
   to play yet" — solved a class of race conditions we had with
   D1-only state.

5. **AI Gateway dynamic routes for every model call.** Recs ranker,
   moderation assist, anything ML. One endpoint, one auth header,
   one set of observability. CI guard fails the build if anyone
   imports an OpenAI SDK or hardcodes a provider URL. Catches
   "I'll just test against the openai endpoint real quick" before
   it merges.

**Things that bit me**

- **Stream webhook delivery is at-least-once.** Idempotent the
  status writes. Learned this the easy way (test env) but worth
  flagging.
- **R2 multipart upload + Worker request limits.** Chunk size has
  to fit Worker req body limits; we landed on 5MB after some
  thrashing.
- **D1 write contention on hot rows (view counts).** Solved with
  a KV write-through cache + periodic flush. Not novel — but
  worth saying because "just write to D1 every view" doesn't
  scale and the docs don't yell about it loudly enough.
- **Sentry on Workers via @sentry/cloudflare** — works well now
  but the integration was rough a year ago. Worth re-checking
  if you bounced off it then.

**Cost reality check**

100 videos, 10k monthly views: $7-15/mo with Stream, $0.50-2/mo
on the R2-only path. README has the full breakdown. The pricing
hasn't materially changed in a year, which I appreciate.

**Where I want eyes**

- The FFmpeg-in-a-Worker queue/retry shape (`src/workers/encoding.ts`).
  It works; I'd believe it has a corner case I haven't hit yet.
- The lifecycle state machine (`src/workers/lifecycle.ts`). Anyone
  who's modeled video state machines and has opinions, I want them.
- Whether I should be using Queues for the encoding job dispatch
  instead of the current DO-driven approach.

Happy to dive into any of the above. MIT licensed if you want
to fork it for your own thing.
```

## In-thread plan

- This community responds well to technical follow-ups. If anyone
  asks "how does X work" expand the answer with code refs.
- If someone from Cloudflare's dev-rel team comments, **don't
  fawn**. Treat it like any other reply.
- Don't link to the HN thread upvote count or the X thread reply
  count. r/CloudFlare hates the "we're doing numbers" angle.
- Mention the AI Gateway guard rail (`scripts/check-no-direct-providers.mjs`)
  if AI Gateway comes up — it tends to.

## After the post is live

1. Paste reddit URL into `coordination.md` → "Live URLs" → Reddit/CloudFlare
2. Reply to the first 3 comments within 30 min (the sub's algorithm
   likes early engagement on smaller-volume posts)
3. If the post gets <5 upvotes in the first hour, that's normal for
   this sub — don't panic, it's a slower-moving community
