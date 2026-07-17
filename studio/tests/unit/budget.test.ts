import { describe, expect, it } from "vitest";
import {
  aiRequestFingerprint,
  aiReservationCostCents,
  aiUsageCostCents,
  budgetCapCents,
  parseIdempotencyKey,
} from "../../apps/web/src/lib/budget";

describe("budget", () => {
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

  it("reserves a conservative upper bound before provider invocation", () => {
    const prompt = JSON.stringify({ messages: [{ content: "Revise this paragraph." }] });
    const reservation = aiReservationCostCents("dynamic/text_gen", prompt, 900);

    expect(reservation).toBeGreaterThanOrEqual(
      aiUsageCostCents({
        route: "dynamic/text_gen",
        tokens_in: new TextEncoder().encode(prompt).byteLength,
        tokens_out: 900,
      }),
    );
    expect(reservation).toBeGreaterThan(
      aiUsageCostCents({ route: "dynamic/text_gen", tokens_in: 11, tokens_out: 3 }),
    );
  });

  it("normalizes valid UUID idempotency keys and rejects malformed keys", () => {
    expect(parseIdempotencyKey(" 01234567-89AB-4DEF-8123-456789ABCDEF ")).toBe(
      "01234567-89ab-4def-8123-456789abcdef",
    );
    expect(parseIdempotencyKey("not-a-uuid")).toBeNull();
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });

  it("fingerprints the complete ordered request and changes with content", async () => {
    const first = await aiRequestFingerprint(["editor-ai", "chapter", "one"]);
    const same = await aiRequestFingerprint(["editor-ai", "chapter", "one"]);
    const changed = await aiRequestFingerprint(["editor-ai", "chapter", "two"]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(same).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("uses the existing plan caps", () => {
    expect(budgetCapCents("free")).toBe(1_000);
    expect(budgetCapCents("pro")).toBe(5_000);
  });
});
