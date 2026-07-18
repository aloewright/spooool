import fs from "node:fs";
import { describe, expect, it } from "vitest";

const rootSource = fs.readFileSync(new URL("../Root.tsx", import.meta.url), "utf8");

const expectDemoComposition = (
  id: "spooool-demo-landscape" | "spooool-demo-vertical",
  width: number,
  height: number,
  duration: "LANDSCAPE_DURATION" | "VERTICAL_DURATION",
  format: "landscape" | "vertical",
) => {
  expect(rootSource).toMatch(
    new RegExp(
      `<Composition\\s+id="${id}"\\s+component=\\{SpoooolDemo\\}\\s+width=\\{${width}\\}\\s+height=\\{${height}\\}\\s+fps=\\{DEMO_FPS\\}\\s+durationInFrames=\\{${duration}\\}\\s+defaultProps=\\{\\{\\s*format:\\s*"${format}"\\s+as\\s+const\\s*\\}\\}`,
    ),
  );
};

describe("Spooool demo registrations", () => {
  it("registers fixed landscape and vertical demo compositions", () => {
    expectDemoComposition(
      "spooool-demo-landscape",
      1920,
      1080,
      "LANDSCAPE_DURATION",
      "landscape",
    );
    expectDemoComposition(
      "spooool-demo-vertical",
      1080,
      1920,
      "VERTICAL_DURATION",
      "vertical",
    );
  });
});
