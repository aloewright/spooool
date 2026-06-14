import { describe, expect, it } from "vitest";
import {
  CHAT_MODEL_ROUTES,
  DEFAULT_CHAT_MODEL_ROUTE,
  resolveChatModelRoute,
} from "../../apps/web/src/shared/chat-models";

describe("chat model routes", () => {
  it("offers the text gen and fable dynamic routes", () => {
    expect(CHAT_MODEL_ROUTES.map((r) => r.id)).toEqual(["dynamic/text_gen", "dynamic/fable_gen"]);
    for (const route of CHAT_MODEL_ROUTES) {
      expect(route.id.startsWith("dynamic/")).toBe(true);
    }
  });

  it("resolves known routes as-is", () => {
    expect(resolveChatModelRoute("dynamic/fable_gen")).toBe("dynamic/fable_gen");
    expect(resolveChatModelRoute("dynamic/text_gen")).toBe("dynamic/text_gen");
  });

  it("clamps unknown or malicious state to the default route", () => {
    expect(resolveChatModelRoute(undefined)).toBe(DEFAULT_CHAT_MODEL_ROUTE);
    expect(resolveChatModelRoute(null)).toBe(DEFAULT_CHAT_MODEL_ROUTE);
    expect(resolveChatModelRoute("anthropic/claude-fable-5")).toBe(DEFAULT_CHAT_MODEL_ROUTE);
    expect(resolveChatModelRoute("dynamic/video_gen")).toBe(DEFAULT_CHAT_MODEL_ROUTE);
    expect(resolveChatModelRoute({ id: "dynamic/fable_gen" })).toBe(DEFAULT_CHAT_MODEL_ROUTE);
  });
});
