import { describe, expect, it } from "vitest";
import {
  APP_BASE_PREFIX,
  detectAppBase,
  rewriteHtmlBase,
} from "../../apps/web/src/shared/app-base";

describe("detectAppBase", () => {
  it("detects the prefix on exact and nested paths", () => {
    expect(detectAppBase("/studio")).toBe(APP_BASE_PREFIX);
    expect(detectAppBase("/studio/")).toBe(APP_BASE_PREFIX);
    expect(detectAppBase("/studio/blogs/abc")).toBe(APP_BASE_PREFIX);
  });

  it("does not match the root or lookalike paths", () => {
    expect(detectAppBase("/")).toBe("");
    expect(detectAppBase("/words")).toBe("");
    expect(detectAppBase("/studioX")).toBe("");
  });
});

describe("rewriteHtmlBase", () => {
  const html = [
    "<title>Book Cook</title>",
    '<link rel="icon" href="/favicon.svg" />',
    '<link rel="modulepreload" href="/assets/chunk.js" />',
    '<script type="module" src="/assets/index.js"></script>',
    '<a href="//cdn.example.com/x">x</a>',
  ].join("\n");

  it("rebases root-absolute src and href attributes", () => {
    const out = rewriteHtmlBase(html, "/studio");
    expect(out).toContain('href="/studio/favicon.svg"');
    expect(out).toContain('href="/studio/assets/chunk.js"');
    expect(out).toContain('src="/studio/assets/index.js"');
  });

  it("uses Editor as the document title for the studio mount", () => {
    const out = rewriteHtmlBase(html, "/studio");
    expect(out).toContain("<title>Editor</title>");
    expect(out).not.toContain("<title>Book Cook</title>");
  });

  it("leaves protocol-relative URLs alone", () => {
    expect(rewriteHtmlBase(html, "/studio")).toContain('href="//cdn.example.com/x"');
  });

  it("is a no-op without a base", () => {
    expect(rewriteHtmlBase(html, "")).toBe(html);
  });
});
