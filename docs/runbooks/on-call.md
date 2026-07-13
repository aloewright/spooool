# On-call runbook

> **Last updated:** 2026-06-08
> **On-call rotation:** see internal staffing doc (or `gh team list` for the current on-call assignee).

This runbook is the first thing to open during an incident. It covers severity classification, first response, escalation, and quick-reference links to the specialist runbooks.

---

## Severity levels

| Level | Definition | Response SLA | Examples |
|---|---|---|---|
| **P0** | Complete outage — all users affected | Page immediately; respond within 15 min | Worker returning 5xx for all requests; D1 unreachable; auth down |
| **P1** | Critical feature broken for most users | Respond within 1 hour | Upload failing sitewide; video playback broken; login loops |
| **P2** | Degraded — significant user impact, workaround exists | Respond within 4 hours | Search returning stale results; thumbnails missing; notifications delayed |
| **P3** | Minor / cosmetic, low blast radius | Best-effort, next business day | Single edge-case 404; cosmetic layout glitch; non-critical email not delivered |

Err toward the higher severity when unsure — you can always downgrade once you have more context.

---

## First response (all severities)

1. **Acknowledge** — post in `#incidents` within the SLA window. Format: `[P{N}] <one-line description> — investigating`.
2. **Open the dashboards** (links below).
3. **Check recent deploys** — was there a deploy in the last 2 hours?
   ```sh
   gh run list --workflow=deploy-prod.yml --limit 5
   gh run list --workflow=deploy-staging.yml --limit 5
   ```
4. **Tail live logs**:
   ```sh
   npx wrangler tail spooool
   ```
5. **Hit the health endpoint** (add `?verbose=1` for extended probe output):
   ```sh
   curl -s https://spooool.com/api/health | jq .
   ```
6. **Decide**: recover first, then root-cause. Don't spend more than 10 minutes diagnosing before attempting recovery.

---

## Recovery playbook

### Worker returning 5xx / crash-looping

1. Check `wrangler tail` for the error class (TypeError, unhandled rejection, D1 error, etc.).
2. If a recent deploy is the culprit, roll back:
   ```sh
   # Revert to the last known-good deployment
   npx wrangler rollback
   # Or redeploy the previous commit explicitly:
   gh workflow run deploy-prod.yml -f ref=<previous-good-sha>
   ```
3. Confirm recovery: `curl -s https://spooool.com/api/health | jq .status`.

### Auth / session failures

1. Check `wrangler tail` for Better-Auth errors (`BETTER_AUTH_SECRET` missing or rotated?).
2. Verify the secret is present: `npx wrangler secret list | grep BETTER_AUTH`.
3. If the secret is missing or was just rotated, re-put it: `npx wrangler secret put BETTER_AUTH_SECRET`.
4. Workers restart automatically after a secret put; allow up to 30 s.

### D1 database errors

Follow `docs/runbooks/d1-backup-restore.md` for the full decision tree. Quick reference:

- **Accidental DELETE / bad migration** → D1 Time Travel:
  ```sh
  wrangler d1 time-travel restore spooool-prod --timestamp '<ISO timestamp before incident>'
  ```
- **Database gone** → restore from R2 backup (see runbook).
- **D1 returning 503 / region error** → Cloudflare infrastructure issue; check https://www.cloudflarestatus.com and wait.

### R2 object not found / 404 on video stream

1. Confirm the video row in D1 has a valid `r2_key`:
   ```sh
   npx wrangler d1 execute spooool-prod --remote --command \
     "SELECT id, r2_key, status FROM videos WHERE id = '<video_id>'"
   ```
2. Confirm the object exists in R2:
   ```sh
   npx wrangler r2 object head spooool-videos '<r2_key>'
   ```
3. If the row exists but the R2 object is missing, the video must be re-encoded or restored from the uploader.

### KV / session cache failures

KV errors are non-fatal — the app degrades gracefully (cache misses fall through to D1). If KV is completely down:

1. The app will be slower but functional.
2. Check Cloudflare status; no actionable fix from this side until upstream recovers.

### Rate limiter Durable Object errors

Rate limiters are fail-open (a DO error lets the request through). If you see sustained DO errors:

1. Check `wrangler tail` for `RateLimiterDO` errors.
2. Confirm the `RATE_LIMITER` DO binding is present: `npx wrangler deployments list` → confirm the binding appears.
3. A fresh deploy resets the DO state; as a last resort, redeploy.

### Sentry alert: error spike

1. Open Sentry and filter to the last 1 hour.
2. Group by `error.type` and `url` to find the dominant failure.
3. Cross-reference with `wrangler tail` for server-side context.
4. If a single release caused the spike, roll back (see "Worker returning 5xx" above).

### Cost alert: storage quota

The daily cron (08:00 UTC) fires a Sentry alert when R2 storage exceeds `COST_STORAGE_ALERT_BYTES` (default 100 GiB). Response:

1. Query top storage consumers:
   ```sh
   npx wrangler d1 execute spooool-prod --remote --command \
     "SELECT user_id, SUM(bytes) AS total FROM videos GROUP BY user_id ORDER BY total DESC LIMIT 20"
   ```
2. Consider lowering per-user quotas or running the account deletion sweep manually.
3. Adjust `COST_STORAGE_ALERT_BYTES` if the threshold is too conservative.

---

## Escalation path

| Situation | Escalate to |
|---|---|
| P0 and unresolved after 30 min | Engineering lead (page via PagerDuty or phone) |
| D1 region outage (Cloudflare-side) | Cloudflare support ticket + status page |
| DMCA / legal concern | Legal contact (see private contacts doc) |
| Payment / Polar issue | Polar support dashboard |
| Repeated abuse / DDoS | Cloudflare WAF + Firewall rules; escalate to security on-call |

---

## Key dashboards and links

| Resource | URL / command |
|---|---|
| Cloudflare Workers dashboard | https://dash.cloudflare.com → Workers & Pages → spooool |
| Workers Logs (live tail) | `npx wrangler tail spooool` |
| Analytics Engine (RUM) | CF dashboard → Analytics → Workers Analytics Engine |
| Sentry (errors) | https://sentry.io → spooool project |
| D1 database | CF dashboard → Storage → D1 → spooool-prod |
| R2 bucket | CF dashboard → R2 → spooool-videos |
| Cloudflare status | https://www.cloudflarestatus.com |
| GitHub Actions (deploys) | `gh run list --workflow=deploy-prod.yml` |
| Health endpoint | https://spooool.com/api/health |
| Status page | https://spooool.com/status |

---

## Post-incident

Within **48 hours** of any P0 or P1 incident:

1. Write a brief postmortem in `#incidents` covering:
   - Timeline (detection → mitigation → resolution)
   - Root cause
   - User impact (estimated affected users and duration)
   - What worked, what didn't
   - Action items with owners and due dates
2. Open GitHub issues for each action item tagged `incident-followup`.
3. Update this runbook if any step was wrong or missing.

---

## See also

- D1 backup + restore: `docs/runbooks/d1-backup-restore.md`
- Recorder pipeline smoke test: `docs/runbooks/recorder-smoke-test.md`
- Security headers: `src/workers/security-headers.ts`
- Rate limiter: `src/workers/rate-limit-do.ts`
- Health check: `src/workers/health.ts`
