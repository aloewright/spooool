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
  // Simple read-modify-write. Acceptable for v1 (low contention per user).
  const raw = await kv.get(KEY(userId));
  const spent = raw ? Number.parseInt(raw, 10) : 0;
  await kv.put(KEY(userId), String(spent + cents), {
    expirationTtl: 60 * 60 * 26,
  });
}
