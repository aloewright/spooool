import { describe, expect, it } from "vitest";
import {
  aiUsageCostCents,
  assertBudget,
  recordUsage,
  todayIso,
} from "../../apps/web/src/lib/budget";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    _store: store,
    // biome-ignore lint/suspicious/noExplicitAny: minimal KV stub
  } as any;
}

describe("budget", () => {
  it("permits when under cap", async () => {
    const kv = fakeKv();
    await expect(assertBudget(kv, "user1", 5000)).resolves.toBeUndefined();
  });

  it("throws BudgetExceeded when over cap", async () => {
    const kv = fakeKv();
    await kv.put(`budget:user1:${todayIso()}`, "5500");
    await expect(assertBudget(kv, "user1", 5000)).rejects.toThrow(/BudgetExceeded/);
  });

  it("recordUsage increments counter", async () => {
    const kv = fakeKv();
    await recordUsage(kv, "user1", 200);
    await recordUsage(kv, "user1", 300);
    expect(kv._store.get(`budget:user1:${todayIso()}`)).toBe("500");
  });

  it("meters completed remote token usage with route-aware weighting", () => {
    expect(aiUsageCostCents({ route: "dynamic/text_gen", tokens_in: 700, tokens_out: 100 })).toBe(
      1,
    );
    expect(
      aiUsageCostCents({ route: "dynamic/research_gen", tokens_in: 700, tokens_out: 100 }),
    ).toBe(2);
    expect(
      aiUsageCostCents({ route: "deterministic/local", tokens_in: 50_000, tokens_out: 50_000 }),
    ).toBe(0);
  });

  it("rejects invalid usage increments", async () => {
    const kv = fakeKv();
    await expect(recordUsage(kv, "user1", -1)).rejects.toThrow(/non-negative safe integer/);
  });
});
