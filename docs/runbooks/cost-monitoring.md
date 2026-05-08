# Cost monitoring + alerts (ALO-126)

> Goal: catch a runaway bill within hours, not on the next invoice.

Spooool runs on Cloudflare. The dominant cost lines are:

| Line | What drives it | Soft alert | Hard cap |
|---|---|---|---|
| Workers requests | Total req/day | 2× 7-day baseline | n/a (paid plan, usage-based) |
| Workers Logs ingestion | `head_sampling_rate` × QPS | 1.5× 7-day baseline | n/a |
| R2 storage | Total bytes (videos + logs) | 1.2× monthly delta | per-user storage quota (ALO-72) |
| R2 Class A ops | PUTs (uploads) | 3× 7-day baseline | rate-limit DO ceilings |
| R2 Class B ops | GETs (watch) | 5× 7-day baseline | n/a |
| D1 reads/writes | DB query volume | 2× 7-day baseline | n/a |
| Stream | Encoded minutes / delivered minutes | 1.5× 7-day baseline | n/a |
| AI Gateway | Token spend per dynamic route | 1.5× 7-day baseline | per-route monthly cap |

## Where the alerts live

Cloudflare → **Notifications** in the dashboard. The configured alerts are:

1. **Workers — Usage threshold** at 2× baseline daily requests, paging on-call.
2. **R2 — Storage growth** weekly, posting to `#cost-watch`.
3. **R2 — Class A ops spike** hourly, paging on-call (this catches an upload abuse loop).
4. **Stream — Encoded minutes spike** daily, posting to `#cost-watch`.
5. **AI Gateway — token spend** per route, daily digest in `#cost-watch`.

Alert routing uses Cloudflare's PagerDuty / webhook destinations — see
the dashboard for current targets. Ownership of the destinations is in
Doppler (`CF_NOTIFICATIONS_WEBHOOK_*`), not in code.

## Daily review

A scheduled GitHub Action (`.github/workflows/cost-digest.yml`, follow-up)
posts the previous day's cost summary to `#cost-watch`. Until that's wired,
the on-call should glance at the Cloudflare → Analytics dashboards once a
day.

## When an alert fires

1. **Identify the line item** (Workers? R2? Stream?). The alert names it.
2. **Check for an abuse pattern** in worker logs:

    ```sh
    # Top IPs by upload count in the last hour
    npx wrangler tail --env production --format json \
      | jq -r 'select(.event.request.url | test("/api/upload")) | .event.request.cf.clientIP' \
      | sort | uniq -c | sort -rn | head
    ```

3. **Tighten the rate limiter** for the affected route in
   `src/workers/rate-limit.ts` if a small set of clients is responsible.
4. **Block at the WAF** for confirmed abuse — Cloudflare → Security → WAF
   → Custom rule on the abusive IPs/ASNs. WAF blocks are reviewable; never
   leave one in place beyond 30 days without a written reason.
5. **For AI Gateway spend:** check the per-route dashboard at
   `https://dash.cloudflare.com/<account>/ai/ai-gateway/<gateway>/analytics`.
   If a dynamic route is being hit unexpectedly hard, rate-limit at the
   gateway settings level *and* in the calling worker.

## Cost discipline rules

* **No model defaults in code.** Always use a `dynamic/*` route — model
  selection lives in Cloudflare so we can swap to a cheaper model without a
  redeploy. The `npm run lint:no-providers` guard enforces this.
* **No unbounded loops over user content** without a per-user ceiling. The
  storage quota (ALO-72) and rate limiter (ALO-126) cover the obvious cases;
  any new endpoint that calls R2/D1/AI Gateway in a loop needs a written
  ceiling in code review.
* **Retain logs for the minimum useful window.** `head_sampling_rate = 0.2`
  in `wrangler.toml` is intentional. If you need 100% sampling for an
  investigation, change it temporarily and revert in the same week.

## Monthly review

First Monday of the month: project lead reviews the previous month's bill,
files any anomalies as Linear tickets, and updates this runbook with
new baselines / thresholds. The thresholds above are starting numbers —
they should drift down as we get a tighter handle on actual usage.
