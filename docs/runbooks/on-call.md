# On-call runbook (ALO-126)

> First responder's guide. Covers paging, triage, common incidents, and
> escalation. Keep this short — when you're on-call at 2am, ten pages of
> prose are a liability.

## Who's paged

* **Primary on-call:** rotates weekly; Linear "On-call" project owns the schedule.
* **Secondary:** previous week's primary.
* **Escalation (after 15 min unack):** project lead.

Pages fire from:

* Cloudflare Workers Logs alerts (5xx rate, error budget)
* Sentry (frontend error spike, new release health regression)
* PostHog (RUM p75 LCP regression)
* External uptime check (`/api/health` returning non-2xx for 3 min)

## Severity ladder

| Sev | Definition | First response |
|---|---|---|
| **SEV-1** | Site down or data loss in progress | Page on-call + secondary; status page within 10 min |
| **SEV-2** | Major feature broken (uploads, watch, auth) for >5% of users | Page on-call; investigate within 15 min |
| **SEV-3** | Degraded UX, single feature affected | Triage in business hours |
| **SEV-4** | Cosmetic / non-blocking | File ticket, no page |

## First five minutes

1. **Acknowledge** the page. Silence the alarm so the team knows someone has it.
2. **Check `/api/health`** on prod and staging:

    ```sh
    curl -fsS https://spooool.com/api/health | jq
    curl -fsS https://staging.spooool.com/api/health | jq
    ```

3. **Tail worker logs** for live errors:

    ```sh
    npx wrangler tail --env production --status error
    ```

4. **Check Sentry** for a release-health regression on the latest deploy.
5. **Check Cloudflare status** at https://www.cloudflarestatus.com/ — rule out upstream.

If health is green but users still report breakage, suspect a frontend
regression (Sentry → Releases → latest → Issues).

## Common playbooks

### Error rate spike right after a deploy

The newest deploy is almost always the cause. Roll back first, diagnose
after — the user-facing fire matters more than the root-cause writeup.

```sh
# List recent deployments
npx wrangler deployments list

# Roll back to the previous version
npx wrangler rollback <deployment-id-of-previous>
```

Then file a postmortem ticket and revert the offending commit on `main`
so the next deploy doesn't re-break prod.

### Database broke (`SELECT 1` failing in `/api/health`)

Use the D1 backup-restore runbook (`docs/runbooks/d1-backup-restore.md`):
Time Travel restore covers anything in the last 30 days.

### Upload pipeline stuck

* Inspect queue depth: Cloudflare dashboard → Queues → `video-encoding`.
* Check the dead letter queue. If items are piling up, an encoder regression
  is likely — capture one DLQ payload, then redrive after the fix.
* `videos` table `lifecycle_state` should advance through `uploaded → encoding → ready`. Stalls in `encoding` past 1 hour are abnormal.

### Rate limiter blocking legitimate users

* The `RATE_LIMITER` Durable Object is the gate. If a single user is being
  blocked unfairly, check `src/workers/rate-limit.ts` for the bucket and
  ceiling that fired.
* Emergency knob: deploy with `RATE_LIMIT_DISABLED=1` set as a worker env var,
  then re-enable once the underlying abuse pattern is fixed. **Never leave
  this on past the incident.**

### DMCA / abuse takedown

See `src/workers/dmca.ts` and `src/workers/moderation.ts`. Moderator queue
lives under `/admin/moderation`. Takedowns flip `lifecycle_state` to
`taken_down` and revoke signed R2 URLs on next request — no separate purge
needed.

### Cost spike

See `docs/runbooks/cost-monitoring.md`.

## Communications

* **Internal:** `#incident-<short-id>` channel, tag the team.
* **External (SEV-1 / SEV-2):** post a status page entry within 10 min.
  "We're investigating elevated error rates" is enough — never speculate
  on cause until you know.
* **Resolution:** post one closing message with what broke, what fixed it,
  and a link to the postmortem ticket.

## After the incident

Within 24h, file a postmortem in Linear under the `incident` label:

* Timeline (UTC).
* Impact (users, duration, severity).
* Root cause (technical and process).
* What we'd change to make this not recur.

No blameless ≠ no accountability. Be specific about what was missing
(monitoring, test coverage, runbook step) and file the follow-ups before
closing the postmortem.
