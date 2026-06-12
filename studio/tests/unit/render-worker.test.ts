import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  normalizeKind,
  packageLaunchHandoff,
} from "../../services/render-worker/src/index";

describe("render worker helpers", () => {
  it("accepts only supported render kinds", () => {
    expect(normalizeKind("epub")).toBe("epub");
    expect(normalizeKind("pdf")).toBe("pdf");
    expect(normalizeKind("kpf")).toBe("kpf");
    expect(normalizeKind("docx")).toBeUndefined();
  });

  it("maps render kinds to upload content types", () => {
    expect(contentTypeFor("epub")).toBe("application/epub+zip");
    expect(contentTypeFor("pdf")).toBe("application/pdf");
    expect(contentTypeFor("kpf")).toBe("application/vnd.amazon.mobi8-ebook");
  });

  it("packages launch handoff files as a zip", async () => {
    const result = await packageLaunchHandoff({
      projectId: "project-1",
      briefMd: "# Launch\n\n## Checklist\n\n- [ ] Ship",
      handoff: { title: "Launch", launch_checklist: ["Ship"] },
      inline: true,
    });

    expect(result.contentType).toBe("application/zip");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.r2Key).toContain("projects/project-1/launch/");
  });
});
