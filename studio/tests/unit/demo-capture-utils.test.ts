import { describe, expect, it } from "vitest";
import { getPngCaptureNames } from "../../scripts/capture-demo-utils.mjs";
import { isLocalStudioApiUrl } from "../e2e/demo-request-guard";

describe("getPngCaptureNames", () => {
  it("ignores non-PNG directory entries and sorts captures", () => {
    expect(getPngCaptureNames(["studio-z.png", ".DS_Store", "notes.txt", "studio-a.png"])).toEqual([
      "studio-a.png",
      "studio-z.png",
    ]);
  });
});

describe("isLocalStudioApiUrl", () => {
  it("accepts only local Studio API URLs", () => {
    expect(isLocalStudioApiUrl("http://localhost:4190/api/v1/projects")).toBe(true);
    expect(isLocalStudioApiUrl("https://spooool.com/api/v1/projects")).toBe(false);
    expect(isLocalStudioApiUrl("http://localhost:4190/studio")).toBe(false);
  });
});
