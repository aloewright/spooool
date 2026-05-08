# Launch coordination — status + oncall plan

**Owner:** aloe
**Launch window:** Tuesday 09:00 PT (T-0)
**Calm-down window:** T-0 → T+24h is "all hands"; T+24h → T+72h is
                       "extra eyes on", normal cadence after.

This is the wrapper around the public-facing copy. The launch posts
themselves matter less than not bricking the site while everyone
is clicking on it for the first time.

## Pre-flight infra (T-7d → T-1d)

| When | Item | Owner | Doc |
|---|---|---|---|
| T-7d | Raise rate-limit DO thresholds to launch values | aloe | `src/workers/rate-limit-do.ts` |
| T-7d | Run k6 load baseline (1k watchers + 50 uploaders) | aloe | `tests/load/` |
| T-5d | Stream encoding minutes balance check (need ≥ 5000 min headroom) | aloe | Cloudflare dashboard |
| T-5d | D1 storage headroom check (≥ 30% free) | aloe | runbook |
| T-3d | Sentry release tag flow verified (release shows up in dashboard) | aloe | n/a |
| T-3d | PostHog dashboard for "launch day signups" pinned | aloe | PostHog |
| T-2d | Demo video uploaded to YouTube as **unlisted** | aloe | `demo-video-script.md` |
| T-2d | Status page tested: trigger fake incident → resolve | aloe | `https://status.spooool.com` |
| T-1d | D1 backup taken (manual snapshot, beyond automated) | aloe | `docs/runbooks/d1-backup-restore.md` |
| T-1d | YouTube demo flipped to **public** + homepage hero swapped in | aloe | n/a |
| T-1d | "Maintenance freeze" — no merges to main except revert PRs | aloe | n/a |
| T-1h | Final smoke test (signup, upload, watch, comment, search) | aloe + oncall | n/a |
| T-1h | `#launch-spooool` Slack channel created with HN/X/Reddit links | aloe | n/a |
| T-15m | Oncall confirms ack in `#oncall-spooool` | oncall | n/a |

## Status-page plan

`https://status.spooool.com` is the single source of truth during
launch. Components tracked:

- API (Workers)
- Video upload
- Video playback (Stream + R2 paths reported separately)
- Search
- Auth
- Database (D1)

**At T-0:** post a "Public launch — high traffic expected, status
will update if anything degrades" advisory. Keep advisory pinned
through T+12h. Roll it down to a normal "operational" state once the
HN/Reddit traffic curve flattens.

**Incident posting threshold:**

- Any user-visible 5xx > 1% sustained for >5 min → status post
- Any p95 latency > 2s sustained for >10 min → status post
- Anything causing data loss → status post immediately, regardless
  of duration

Don't wait until you're "sure" — post early, downgrade later. The
audience right now is technical; they reward transparency.

## Oncall plan

| Slot | Coverage | Responder |
|---|---|---|
| T-1h → T+4h (launch peak) | active | aloe (primary) |
| T+4h → T+12h | active, slack-attentive | aloe (primary) |
| T+12h → T+24h | passive, paged on alert | aloe (primary) |
| T+24h → T+72h | normal oncall rotation | rotation |

If aloe is the only person, the "oncall" line really means "phone
on, laptop within reach." Document this honestly — do not pretend
there's a 24/7 rotation that doesn't exist.

### Pager / alert wiring

- Sentry → email + push for any new error_event with > 5/min rate
- Cloudflare logpush → PostHog → dashboard alert on:
  - 5xx rate > 1% in 5min window
  - Worker CPU time > 50ms p99 in 5min window
- Status-page incidents auto-post to `#status-spooool` Slack
  webhook (verify wiring at T-3d)

### Runbook quick-links

- Database problems → `docs/runbooks/d1-backup-restore.md`
- Encoding stuck → `src/workers/encoding.ts` + `lifecycle.ts` (no
  formal runbook yet — gap, file follow-up after launch)
- Rate-limit too aggressive → bump DO thresholds via wrangler config
  hot-edit, do not redeploy in flight

## Communication tree

| Audience | Channel | When |
|---|---|---|
| Internal (just aloe + oncall + close advisors) | `#launch-spooool` Slack | T-7d → T+72h |
| Status updates | `https://status.spooool.com` | as needed |
| Live URLs (HN, X, Reddit) | this doc, "Live URLs" section | as posted |
| Post-launch retro | filed as separate Linear ticket | T+72h |

## Rollback / "abort launch" criteria

If any of the following are true at T-30m, **delay launch by 24h**:

- Site returns 5xx on a fresh-incognito homepage load
- Upload flow fails on the first attempt with a real test file
- Watch page won't play a freshly-encoded test video
- D1 is reporting elevated error rate
- Status page itself is down

Pulling launch is cheap; launching broken is expensive. There's no
single "we have to ship today" deadline. ALO-185 is a launch
*announcement*, not a hard external commitment.

## Live URLs (filled at launch)

```
HN:                <fill at T-0>
X thread (tweet 1): <fill at T-0+5m>
r/selfhosted:      <fill at T-0+30m>
r/CloudFlare:      <fill at T-0+60m>
YouTube demo:      <fill T-1d>
Status advisory:   <fill at T-0>
```

After all six are filled, paste the same block into the top of
`#launch-spooool` and pin it.

## Post-launch debrief (T+72h)

Within 72 hours of launch, file a follow-up Linear ticket capturing:

- Peak concurrent watchers (PostHog)
- Peak QPS (Workers analytics)
- Sentry error rate over the launch window
- Cloudflare bill delta vs. baseline
- Any incident posted to status, with root cause + fix link
- HN final position, comment count, signup conversion
- Reddit final position on each sub
- X engagement on the thread
- What we'd do differently next time — *especially* anything that
  required a manual intervention that should have been automated

This isn't optional. Skipping the debrief is the difference
between "we launched" and "we learned how to launch."
