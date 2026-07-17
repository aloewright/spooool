export function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class BudgetExceeded extends Error {
  constructor(
    public readonly userId: string,
    public readonly cap: number,
  ) {
    super(`BudgetExceeded: user=${userId} cap=${cap}`);
    this.name = "BudgetExceeded";
  }
}

const KEY = (userId: string) => `budget:${userId}:${todayIso()}`;

export type AiBudgetUsage = {
  route: "dynamic/text_gen" | "dynamic/research_gen" | "deterministic/local";
  tokens_in: number;
  tokens_out: number;
};

// Gateway routes may select different providers, so they cannot expose an
// exact provider invoice here. Meter a conservative, stable internal cost:
// output tokens count 3x input tokens and research calls count 2x text calls.
// A remote request always costs at least one cent; local deterministic work is
// free because it does not consume a hosted model.
export function aiUsageCostCents(usage: AiBudgetUsage): number {
  if (usage.route === "deterministic/local") return 0;
  const inputTokens = nonNegativeTokenCount(usage.tokens_in);
  const outputTokens = nonNegativeTokenCount(usage.tokens_out);
  const routeMultiplier = usage.route === "dynamic/research_gen" ? 2 : 1;
  return Math.max(1, Math.ceil(((inputTokens + outputTokens * 3) * routeMultiplier) / 1_000));
}

export async function assertBudget(
  kv: KVNamespace,
  userId: string,
  capCents: number,
): Promise<void> {
  const raw = await kv.get(KEY(userId));
  const spent = raw ? Number.parseInt(raw, 10) : 0;
  if (spent >= capCents) throw new BudgetExceeded(userId, capCents);
}

export async function recordUsage(kv: KVNamespace, userId: string, cents: number): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError("usage cents must be a non-negative safe integer");
  }
  if (cents === 0) return;
  // Simple read-modify-write. Acceptable for v1 (low contention per user).
  const raw = await kv.get(KEY(userId));
  const spent = raw ? Number.parseInt(raw, 10) : 0;
  await kv.put(KEY(userId), String(spent + cents), {
    expirationTtl: 60 * 60 * 26,
  });
}

function nonNegativeTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
