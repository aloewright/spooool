import { describe, expect, it } from "vitest";
import { collectMarketRecords } from "../../apps/web/src/skills/scout/dataset";

describe("market dataset collector", () => {
  it("returns deterministic fallback records without gateway credentials", async () => {
    const records = await collectMarketRecords({
      AI_GATEWAY_BASE_URL: "",
      AI_GATEWAY_TOKEN: "",
    });

    expect(records.length).toBeGreaterThanOrEqual(15);
    expect(records.map((record) => record.source)).toContain("kdp");
    expect(records.map((record) => record.source)).toContain("trends");
    expect(records.map((record) => record.source)).toContain("library");
    expect(records[0].keywords.length).toBeGreaterThan(0);
  });
});
