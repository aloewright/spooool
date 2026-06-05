// Shared write helper for the ai_costs append-only ledger (ALO-675).
// Call from every route that invokes a Workers AI model so spend is
// visible in getCostSnapshot and the /api/admin/costs dashboard.
//
// Two entry points:
//   aiCostStatement — returns a D1PreparedStatement for use in DB.batch()
//     (atomically writes generated_assets + ai_costs together)
//   writeAiCost     — standalone await for routes that aren't batching

export type AiCostUnitKind = 'tokens' | 'seconds' | 'images' | 'characters';

export interface AiCostEntry {
  userId: string;
  op: string;        // e.g. 'image_gen', 'chat_gen', 'video_gen'
  route: string;     // e.g. 'dynamic/image_gen'
  model: string;     // full @cf/* id or provider/model slug
  units: number;     // 1 image, N tokens, etc.
  unitKind: AiCostUnitKind;
  estUsd: number;    // order-of-magnitude placeholder
  projectId?: string | null;
}

export interface AiCostEnv {
  DB: D1Database;
}

export function aiCostStatement(env: AiCostEnv, entry: AiCostEntry): D1PreparedStatement {
  const id = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    entry.userId,
    entry.op,
    entry.route,
    entry.model,
    entry.units,
    entry.unitKind,
    entry.estUsd,
    entry.projectId ?? null,
    now,
  );
}

export async function writeAiCost(env: AiCostEnv, entry: AiCostEntry): Promise<void> {
  await aiCostStatement(env, entry).run();
}
