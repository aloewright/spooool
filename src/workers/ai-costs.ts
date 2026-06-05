// Append-only AI cost ledger helper. Every generative op (image, video, audio,
// caption, metadata) calls writeAiCost so costs.ts can aggregate spend via
// SUM(est_usd) FROM ai_costs. Centralising the insert avoids drift in id
// generation and column ordering across consumers.

export interface AiCostEntry {
  userId: string;
  op: string;
  route: string;
  model: string;
  units: number;
  unitKind: 'tokens' | 'seconds' | 'images' | 'characters';
  estUsd: number;
  projectId?: string | null;
}

export interface AiCostsDbEnv {
  DB: D1Database;
}

export async function writeAiCost(env: AiCostsDbEnv, entry: AiCostEntry): Promise<void> {
  const id = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await env.DB.prepare(
    `INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      entry.userId,
      entry.op,
      entry.route,
      entry.model,
      entry.units,
      entry.unitKind,
      entry.estUsd,
      entry.projectId ?? null,
      Date.now(),
    )
    .run();
}
