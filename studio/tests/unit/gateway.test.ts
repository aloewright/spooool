import { describe, expect, it, vi } from "vitest";
import { gateway } from "../../apps/web/src/lib/gateway";

describe("gateway helper", () => {
  it("chatCompletion routes through dynamic/text_gen", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })),
      );
    // biome-ignore lint/suspicious/noExplicitAny: minimal env stub for unit test
    const env: any = {
      AI_GATEWAY_BASE_URL: "https://gateway.example/compat",
      AI_GATEWAY_TOKEN: "tok",
    };

    const out = await gateway.chatCompletion(env, {
      messages: [{ role: "user", content: "hi" }],
      route: "dynamic/text_gen",
      fetch: fetchMock,
    });

    expect(out.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/chat/completions");
    expect(init.headers["cf-aig-authorization"]).toBe("Bearer tok");
    expect(init.headers["cf-aig-zdr"]).toBe("true");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("dynamic/text_gen");
  });

  it("rejects when route is not a dynamic/* slug", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal env stub for unit test
    const env: any = { AI_GATEWAY_BASE_URL: "x", AI_GATEWAY_TOKEN: "t" };
    await expect(
      gateway.chatCompletion(env, {
        messages: [{ role: "user", content: "hi" }],
        // @ts-expect-error — testing runtime guard
        route: "openai/gpt-5.5",
      }),
    ).rejects.toThrow(/dynamic\//);
  });
});
