# AI Cost Ledger Aggregation + Caps — ALO-650 Plan

> Use superpowers:subagent-driven-development. Grounded against the real `costs.ts`.

**Goal:** Standardize `ai_costs` writes behind a shared helper, aggregate AI spend into the cost snapshot, and add an `ai_spend_threshold` alert — closing the "`ai_costs` written but not read" follow-up from #147/#151.

**Depends on:** ALO-626 (`ai_costs` table), ALO-646/647 (the two inline `ai_costs` writers to refactor). Stacked on `alo-647`.

## Scope
1. **`src/workers/ai-costs.ts` (new):** `aiCostStatement(db, input): D1PreparedStatement` (prepared+bound, for batching) + `writeAiCost(db, input): Promise<void>` (= `aiCostStatement(...).run()`). `input = { userId, op, route, model, units, unitKind: 'tokens'|'seconds'|'images'|'characters', estUsd, projectId?: string|null }`; id `c_…`, `created_at = Date.now()`.
2. **Refactor the two inline inserts:** `studio.ts` image endpoint — replace the inline `INSERT INTO ai_costs` inside its `DB.batch([...])` with `aiCostStatement(c.env.DB, { userId:user.id, op:'image_gen', route:'dynamic/image_gen', model:IMAGE_MODEL, units:1, unitKind:'images', estUsd:EST_USD_PER_IMAGE })` (keeps the batch atomic with the `generated_assets` insert). `ai-video-consumer.ts` — replace its inline insert with `await writeAiCost(env.DB, { userId, op:'video_gen', route:'dynamic/video_gen', model:'google/veo-3.1', units:8, unitKind:'seconds', estUsd:EST_USD_PER_VIDEO })`.
3. **`costs.ts` aggregation:**
   - `CostSnapshot` += `ai_spend: { total_usd: number; last_30d_usd: number }`.
   - `getCostSnapshot`: add two queries (ai_costs.created_at is INTEGER ms, reuse `thirtyDaysAgoMs`): `SELECT COALESCE(SUM(est_usd),0) AS used FROM ai_costs` (total) + `… WHERE created_at >= ?` bind `thirtyDaysAgoMs` (30d). Round to cents.
   - `CostAlert` → union: `{ reason:'storage_threshold'; threshold_bytes; observed_bytes } | { reason:'ai_spend_threshold'; threshold_usd; observed_usd }`.
   - `evaluateAlerts(snapshot, thresholdBytes, aiSpendThresholdUsd)`: keep storage; add an ai_spend alert when `snapshot.ai_spend.last_30d_usd >= aiSpendThresholdUsd`.
   - `parseAiSpendThresholdUsd(raw)` + `CostsEnv.COST_AI_SPEND_ALERT_USD?: string` (default e.g. `$50`).
   - `buildCostAlertProps`: handle the union (find the storage alert for `threshold_gib`; add `ai_spend_total_usd`, `ai_spend_30d_usd`, `ai_spend_threshold_usd`, and include `ai_spend_threshold` in `alert_reasons`).
   - `runCostMonitorSweep` + `GET /api/admin/costs`: thread `parseAiSpendThresholdUsd(env.COST_AI_SPEND_ALERT_USD)` into `evaluateAlerts`; the admin response gains `ai_spend_threshold_usd`.
4. **Caps:** `STUDIO_GEN_BUCKET` (30/hr) already gates the gen endpoints (429) — leave as the v1 cap. Per-tier Polar caps remain deferred (Polar not wired); note it.
5. **Tests:** `ai-costs.test.ts` (statement SQL/binds + writeAiCost runs); `costs.test.ts` (ai_spend aggregation in the snapshot + `ai_spend_threshold` fires above the bound, not below); update `studio.test.ts` (image batch still has the ai_costs statement) + `ai-video-consumer.test.ts` (writeAiCost path) if their assertions changed.

## Acceptance criteria (ALO-650)
- [ ] Every studio image/video op writes an `ai_costs` row via the shared helper.
- [ ] `getCostSnapshot` includes summed AI spend (`ai_spend`); `GET /api/admin/costs` exposes it + `ai_spend_threshold_usd`.
- [ ] `evaluateAlerts` emits `ai_spend_threshold` above a configurable bound.
- [ ] `STUDIO_GEN_BUCKET` 429 (already shipped).
- [ ] Unit tests cover ledger math + alert threshold. `lint:no-providers` green.
