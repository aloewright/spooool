# D1 backup + restore runbook (ALO-175)

> **Database:** `cloudflare-tube-prod` (binding `DB`, id `bcf1a3f9-3732-4770-aae2-774decf68171`).
> **Last drilled:** _fill in after the next quarterly drill._

## RPO / RTO targets

| Scenario | RPO (max acceptable data loss) | RTO (max acceptable recovery time) |
|---|---|---|
| Accidental DROP / bad migration | **30 minutes** (covered by D1 Time Travel) | **15 minutes** (`wrangler d1 time-travel restore`) |
| Database lost / project deleted | **24 hours** (covered by daily R2 export) | **2 hours** (recreate D1 + replay export + apply migrations) |
| Region-wide CF D1 outage | Bound by D1's own SLA | Wait for upstream; nothing actionable from this side |

These are commitments, not nice-to-haves. If a real incident exceeds either number, it's a postmortem.

## What's automatic

D1 ships with **Time Travel** — every transaction is journaled and you can restore the database to any point in the last 30 days from a bookmark or timestamp without contacting support. This is the first tool to reach for in any "I broke prod" moment.

```sh
# How far back can we go?
wrangler d1 time-travel info cloudflare-tube-prod

# Get a bookmark for "right now" — record it before any risky migration
wrangler d1 time-travel info cloudflare-tube-prod --json | jq -r .bookmark
```

## What we add on top

Time Travel covers accidental writes. It does **not** cover the project / database being deleted, or a need to spin up a parallel database for staging. For that we keep weekly SQL exports in R2.

### Weekly export to R2

Run from a trusted developer machine (or a scheduled GitHub Action when we add one — out of scope for this runbook):

```sh
# 1. Export to a SQL file. Use --remote so the export targets the live DB,
#    not a local miniflare snapshot.
TS=$(date -u +%Y%m%d-%H%M%S)
wrangler d1 export cloudflare-tube-prod \
  --remote \
  --output "/tmp/d1-${TS}.sql"

# 2. Upload to R2. The bucket below should already exist; create it once
#    with `wrangler r2 bucket create cloudflare-tube-backups` if not.
wrangler r2 object put "cloudflare-tube-backups/d1/cloudflare-tube-prod-${TS}.sql" \
  --file "/tmp/d1-${TS}.sql"

# 3. Verify the upload.
wrangler r2 object get "cloudflare-tube-backups/d1/cloudflare-tube-prod-${TS}.sql" \
  --file /tmp/verify.sql && wc -l /tmp/verify.sql
```

Retention policy: keep **8 weekly snapshots** plus **the most recent 4 monthly snapshots**. R2 lifecycle rules can enforce this automatically — see `docs/runbooks/d1-backup-retention.md` (TODO once we wire the rules; for now do it manually with `wrangler r2 object delete`).

## Restore scenarios

### A. Bad migration / accidental DELETE just landed

1. **Stop further writes** if the bug is still active. If it's a runaway script, kill it. If it's a bad deploy, roll back the worker first (`wrangler rollback` or redeploy the previous build).
2. Find the bookmark just **before** the bad change:
   ```sh
   # Pick a timestamp ~1 minute before the incident
   wrangler d1 time-travel restore cloudflare-tube-prod --timestamp '2026-05-04T18:42:00Z'
   ```
   Or, if you stamped a bookmark before a risky migration:
   ```sh
   wrangler d1 time-travel restore cloudflare-tube-prod --bookmark <bookmark-from-earlier>
   ```
3. The CLI will print a confirmation prompt — read it carefully. Time Travel is a destructive operation: it **rewinds the entire database**, dropping any writes that happened after the chosen point.
4. Verify with a smoke query:
   ```sh
   wrangler d1 execute cloudflare-tube-prod --remote --command \
     "SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM videos"
   ```
5. Rerun the post-incident-affected migrations only if they were intended; otherwise the database is now back where it was before the incident.

### B. Database is gone (deleted, corrupted beyond Time Travel, etc.)

1. Recreate the D1 database. **Do not reuse the old name** if the old one might still be referenced anywhere — append a suffix:
   ```sh
   wrangler d1 create cloudflare-tube-prod-restored
   ```
2. Update `wrangler.toml` `database_id` to point at the new database. Hold off on deploying the worker until step 5.
3. Pull the most recent SQL export from R2:
   ```sh
   wrangler r2 object get \
     cloudflare-tube-backups/d1/cloudflare-tube-prod-<TS>.sql \
     --file /tmp/restore.sql
   ```
4. Replay it:
   ```sh
   wrangler d1 execute cloudflare-tube-prod-restored --remote --file /tmp/restore.sql
   ```
5. Apply any migrations newer than the snapshot (necessary because the export captures only what was in the DB at backup time):
   ```sh
   wrangler d1 migrations apply cloudflare-tube-prod-restored --remote
   ```
6. Smoke-test:
   ```sh
   wrangler d1 execute cloudflare-tube-prod-restored --remote --command \
     "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   ```
7. Deploy the worker pointed at the new database. Watch `/api/health` for green status.

### C. Need a one-off staging clone

Same flow as B, but create the new database with an explicit suffix and never repoint production at it:

```sh
wrangler d1 create cloudflare-tube-staging-from-prod
wrangler r2 object get cloudflare-tube-backups/d1/cloudflare-tube-prod-<TS>.sql --file /tmp/clone.sql
wrangler d1 execute cloudflare-tube-staging-from-prod --remote --file /tmp/clone.sql
```

## Drill cadence

Run scenario **A** quarterly against staging — pick a noisy table, delete a few rows, restore to a pre-deletion bookmark, confirm row count matches. Note the date at the top of this file.

Scenario **B** is harder to drill (creates real D1 instances) but should be exercised at least once before public launch.

## Recovery checklist (print + tape next to monitor)

- [ ] Stop ongoing damage (kill scripts, roll back worker if needed)
- [ ] Capture incident timestamp + describe the bad write
- [ ] Pick the recovery scenario (A, B, or C above)
- [ ] Run the restore commands; verify with the smoke query
- [ ] Reapply any post-snapshot migrations that should still be live
- [ ] Confirm `/api/health` is green and `wrangler tail` shows normal traffic
- [ ] Postmortem within 48h: root cause + a guardrail to prevent recurrence

## See also

- Cloudflare D1 Time Travel docs: <https://developers.cloudflare.com/d1/reference/time-travel/>
- `wrangler d1` reference: <https://developers.cloudflare.com/workers/wrangler/commands/#d1>
- Migrations live under `src/db/migrations/` — never edit a landed migration; always add a new one.
