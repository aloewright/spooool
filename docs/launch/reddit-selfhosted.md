# Reddit cross-post — r/selfhosted

**Surface:** [r/selfhosted](https://www.reddit.com/r/selfhosted/)
**When:** T-0 + 30 min (after HN URL is in hand)
**Flair:** `Release` (or `Self-Promotion` if mods require — check
            most recent megathread for current rule)
**Account:** primary; must satisfy r/selfhosted's 90-day account /
             positive-karma rule. Verify ahead of time.

## Subreddit rules to remember

r/selfhosted is one of the stricter subs. The relevant rules at time
of writing:

1. **Self-promotion is permitted only if you're substantively engaged
   with the community.** Read the thread. Reply to comments. Don't
   post-and-bounce.
2. **Title must describe what the project does, not just the name.**
   "spooool" alone will get removed.
3. **Disclose if you are the developer.** Auto-mod scans for "I
   built", "I made"; that's fine, but explicitly say you wrote it.
4. **No affiliate links, no "free trial" framing.** This is a
   self-host project, post about self-hosting, not a hosted offering.
5. **Source link required.** GitHub URL goes in the post body, not
   only the live demo.

## Title

```
spooool — self-hosted YouTube alternative that runs entirely on Cloudflare's free + cheap tiers (open source)
```

Backup if removed for length:

```
spooool — open-source self-hosted video host on Cloudflare (Workers, R2, Stream, D1)
```

## Body (paste-ready)

```
Hi r/selfhosted — I built spooool, an open-source YouTube alternative
that's designed to run entirely on Cloudflare's developer platform.
I'm posting because I think this community in particular will have
the sharpest critiques of the tradeoffs.

Repo: https://github.com/aloewright/spooool
Live demo: https://spooool.com
HN discussion (more nerd questions there): <HN URL — fill at launch>

**What it does**

- Upload videos via web UI to R2
- Encode to HLS (Cloudflare Stream OR FFmpeg-in-a-Worker — both
  paths supported, you choose)
- Adaptive bitrate playback in-browser
- Channels / creators, comments + nested replies, search, watch
  history, playlists
- Email auth via better-auth (verification + active-session revoke)
- DMCA + content-moderation queue baked in
- Per-user storage quotas with proper 413 + machine-readable codes

**What it isn't**

- Not federated (it's not a Mastodon-for-video; that's PeerTube's
  niche and PeerTube does it well)
- Not P2P
- Not running on your own metal — this is "self-hosted on someone
  else's infra," which is a tradeoff I want to be honest about

**The honest pitch for this community**

If your definition of "self-hosted" requires bare metal or a VPS, this
isn't for you and I won't argue. But if "self-hosted" to you means "I
own the data, I own the code, I'm not paying a SaaS to host it for me,
and I can move it whenever I want" — spooool fits.

Cloudflare is the dependency. The math basically doesn't work anywhere
else: R2's $0/GB-egress is what makes per-video costs land at <$0.05/mo.
On AWS the same shape would be 10-30× the cost depending on viewer
geography.

**Cost**

- 100 videos / 10k monthly views: $7-15/mo with Stream encoding,
  $0.50-2/mo with the R2-only / FFmpeg path
- Most of the bill is Stream encoding minutes, which you can swap
  out for the R2-only path if you don't mind running FFmpeg

**Setup**

1. `wrangler login`
2. Create R2 bucket + D1 database (one command each)
3. `wrangler deploy`
4. Done

I'd love feedback on:

- The R2-only encoding path. It works but it's the most novel piece
  and I want eyes on the queue/retry shape.
- The "is this really self-hosted" question. Genuinely interested
  in this community's view — I lean yes, but I get the argument
  against.
- Anything in the cost table I've missed.

Disclosure: I'm the developer. Not affiliated with Cloudflare. Not
selling anything — there's no hosted version, no paid tier, no
upsell. MIT licensed.

Happy to answer anything.
```

## In-thread plan

- **Stay for at least 4 hours after posting.** The sub's culture
  rewards engagement.
- **Lead with the "is this really self-hosted" framing in your
  first reply.** Nine times out of ten that's the top comment.
  Acknowledge it, don't dodge it. Answer below.
- **Don't argue with downvotes.** If a post-and-thread idea gets
  pushed back hard, take the L on that point publicly.
- **Don't mention the X thread.** This community is deeply skeptical
  of self-promo trains.

### Pre-canned reply: "is this really self-hosted"

```
Honest answer: depends on your definition. If "self-hosted" means
bare-metal or VPS, no — this needs Cloudflare. If it means "I own
the data, the code is open source, I can leave whenever, no SaaS
holds my content hostage" — then yes.

For what it's worth: the data lives in your own R2 bucket and D1
database under your account. The Worker code is your code, deployed
to your account. Cloudflare is the substrate, not the operator.
You can pull the entire thing off Cloudflare; the abstractions are
already in place, I just haven't bothered porting because the cost
math is so much better on Cloudflare.
```

### Pre-canned reply: "but what if Cloudflare bans me / has an outage"

```
Both real concerns.

Outage: Cloudflare has had outages. So has every cloud. Spooool's
RPO/RTO is documented in docs/runbooks/d1-backup-restore.md — short
version: D1 daily backups + R2 versioning means a regional CF outage
loses you uptime, not data.

Ban: this is the harder question and the honest answer is you'd
need to migrate. Worth thinking about which providers' terms you're
comfortable depending on. CF's are not the worst in the industry,
but they aren't a public utility either.
```

### Pre-canned reply: "why not just use [other tool]"

```
Genuinely happy to explain the tradeoff vs. whichever tool — drop
the name and I'll write up the comparison. Short version of the
common ones:

- PeerTube: better if you want federation + you have a server.
  Not better if you want zero-ops.
- Owncast: built for live streaming a single creator. Different
  use case.
- Plex / Jellyfin: media library for content you already own.
  Different use case (those don't take public uploads or do
  signup/auth).
```

## After the post is live

1. Paste reddit URL into `coordination.md` → "Live URLs" → Reddit/selfhosted
2. Set a reminder to check the thread every 30 min for the first 4 hours
3. If removed by automod, do not repost — message the mods first
