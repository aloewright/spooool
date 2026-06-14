import { describe, expect, it } from "vitest";
import { assertBudget, recordUsage, todayIso } from "../../apps/web/src/lib/budget";

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
});
