import fs from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceText = fs.readFileSync(new URL("../Root.tsx", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile(
  "Root.tsx",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const readAttributes = (element: ts.JsxSelfClosingElement) =>
  Object.fromEntries(
    element.attributes.properties.flatMap((property) => {
      if (!ts.isJsxAttribute(property) || !property.initializer) return [];
      const name = property.name.getText(sourceFile);
      const value = ts.isStringLiteral(property.initializer)
        ? property.initializer.text
        : property.initializer.expression?.getText(sourceFile).replace(/\s+/g, " ");
      return value === undefined ? [] : [[name, value]];
    }),
  );

const registrations: Record<string, string>[] = [];
const visit = (node: ts.Node) => {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sourceFile) === "Composition") {
    const attributes = readAttributes(node);
    if (attributes.id?.startsWith("spooool-demo-")) registrations.push(attributes);
  }
  ts.forEachChild(node, visit);
};
visit(sourceFile);

describe("Spooool demo registrations", () => {
  it("registers the active landscape and vertical compositions", () => {
    expect(registrations).toEqual([
      {
        id: "spooool-demo-landscape",
        component: "SpoooolDemo",
        width: "1920",
        height: "1080",
        fps: "DEMO_FPS",
        durationInFrames: "LANDSCAPE_DURATION",
        defaultProps: '{ format: "landscape" as const }',
      },
      {
        id: "spooool-demo-vertical",
        component: "SpoooolDemo",
        width: "1080",
        height: "1920",
        fps: "DEMO_FPS",
        durationInFrames: "VERTICAL_DURATION",
        defaultProps: '{ format: "vertical" as const }',
      },
    ]);
  });
});
