// Shared writer for the ai_costs ledger (0022). Two forms: a prepared
// statement (for batching with another insert) and a convenience runner.
export type AiCostUnitKind = 'tokens' | 'seconds' | 'images' | 'characters';
export interface AiCostInput {
  userId: string;
  op: string;          // e.g. 'image_gen' | 'video_gen'
  route: string;       // e.g. 'dynamic/image_gen' (ledger annotation; actual call is gateway-routed)
  model: string;       // e.g. '@cf/black-forest-labs/flux-1-schnell'
  units: number;
  unitKind: AiCostUnitKind;
  estUsd: number;
  projectId?: string | null;
}

export function aiCostStatement(db: D1Database, input: AiCostInput): D1PreparedStatement {
  const id = `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return db.prepare(
    `INSERT INTO ai_costs (id, user_id, op, route, model, units, unit_kind, est_usd, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.userId, input.op, input.route, input.model, input.units, input.unitKind, input.estUsd, input.projectId ?? null, Date.now());
}

export async function writeAiCost(db: D1Database, input: AiCostInput): Promise<void> {
  await aiCostStatement(db, input).run();
}
