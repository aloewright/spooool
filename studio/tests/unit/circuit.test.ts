import { describe, expect, it } from "vitest";
import { checkCircuit, resetCircuit, tripCircuit } from "../../apps/web/src/lib/circuit";

function fakeKv() {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    async get(k: string) {
      const e = store.get(k);
      if (!e) return null;
      if (e.expiration && Date.now() / 1000 > e.expiration) {
        store.delete(k);
        return null;
      }
      return e.value;
    },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      const expiration = opts?.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : undefined;
      store.set(k, { value: v, expiration });
    },
    async delete(k: string) {
      store.delete(k);
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal KV stub
  } as any;
}

describe("circuit breaker", () => {
  it("starts closed", async () => {
    const kv = fakeKv();
    expect(await checkCircuit(kv, "u", "writer")).toBe("closed");
  });

  it("opens after trip", async () => {
    const kv = fakeKv();
    await tripCircuit(kv, "u", "writer", 60);
    expect(await checkCircuit(kv, "u", "writer")).toBe("open");
  });

  it("reset clears the open state", async () => {
    const kv = fakeKv();
    await tripCircuit(kv, "u", "writer", 60);
    await resetCircuit(kv, "u", "writer");
    expect(await checkCircuit(kv, "u", "writer")).toBe("closed");
  });
});
