# spooool launch kit (ALO-185)

Source-of-truth launch copy for the public release of **spooool** — a video
host that respects your time, built entirely on Cloudflare.

This directory holds the ready-to-post copy for each surface plus the
coordination plan that wraps around them. Treat the files as drafts that get
checked in, reviewed in PR, then copy-pasted to the destination at launch
time. Nothing here is auto-published.

## Surfaces

| File | Surface | Owner | When |
|---|---|---|---|
| [`show-hn.md`](./show-hn.md) | Hacker News (Show HN) | aloe | T-0 (Tue 09:00 PT) |
| [`x-thread.md`](./x-thread.md) | X / Twitter thread | aloe | T-0 + 5 min |
| [`reddit-selfhosted.md`](./reddit-selfhosted.md) | r/selfhosted | aloe | T-0 + 30 min |
| [`reddit-cloudflare.md`](./reddit-cloudflare.md) | r/CloudFlare | aloe | T-0 + 60 min |
| [`demo-video-script.md`](./demo-video-script.md) | 60-90s demo video | aloe | recorded T-3d, finalized T-1d |
| [`coordination.md`](./coordination.md) | Status page + oncall plan | aloe + oncall | T-7d through T+24h |

## Tuesday 09:00 PT?

Tuesday morning Pacific is a deliberate pick:

- **HN front-page math.** Show-HN posts that hit the front page in the first
  90 minutes typically get the longest dwell. Tue 09:00 PT lands as US East
  is mid-morning and EU is wrapping the workday — broadest awake audience.
- **r/selfhosted** is most active on weekdays; Tuesday avoids Monday's
  release-week noise.
- **r/CloudFlare** skews lower volume but reads through the day.

Friday afternoon and weekends are explicitly avoided — oncall coverage
thins out and any infra hiccup gets a smaller responder pool.

## Sequencing rationale

1. **Show HN goes first.** Threads are read sequentially; we want the canonical
   long-form to be the HN comment thread.
2. **X thread 5 minutes later.** Links to the HN post in the final tweet so
   X readers can pile on the comment thread.
3. **Reddit cross-posts staggered 30/60 min.** Reddit's spam heuristic
   penalizes simultaneous cross-posts. Different subs, different framing
   per subreddit rules.
4. **No Twitter "we're live" tweet without HN URL.** If HN is dead before
   posting, fall back to the homepage URL — see `coordination.md` runbook.

## House rules for the copy

- **No emoji in HN title.** Mods strip them and it looks try-hard.
- **No "Show HN: We" — use the singular voice.** It's a solo+small project.
- **State the cost.** "$2-15/month at small scale" lands harder than
  vague "cheap."
- **Link the source repo before the live URL.** HN crowd self-selects for
  open-source first.
- **No "AI-powered" marketing in titles.** spooool is infra, not a model wrapper.
- **Disclose the affiliation.** On r/CloudFlare, lead with "I built this on
  Cloudflare's stack — not affiliated with Cloudflare." Mods are strict.

## What ships in this PR vs. at launch

This PR ships the **copy and plan only**. None of these channels are posted
to from CI or from a script. At launch, the on-call human:

1. Opens each file
2. Copies the body into the destination
3. Pins the resulting URLs in `coordination.md` under "Live URLs"
4. Files a follow-up to amend the doc with the as-posted versions

The reason for the manual step is editorial: HN/X/Reddit each have their
own moderation quirks (rate limits, automod, link allowlists) and a human
should be the one accepting any last-minute edits demanded by the platform.
