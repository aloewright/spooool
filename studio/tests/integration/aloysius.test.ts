import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Book Cook editorial assistant DO", () => {
  it("WebSocket connects and handles the AI chat protocol", async () => {
    const id = crypto.randomUUID();
    const res = await SELF.fetch(`http://x/agents/aloysius/${id}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("missing webSocket on response");
    ws.accept();

    const got = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => {
        const parsed = JSON.parse(String(e.data)) as { type: string };
        if (parsed.type === "cf_agent_stream_resume_none") resolve(String(e.data));
      });
      ws.send(JSON.stringify({ type: "cf_agent_stream_resume_request" }));
    });

    const msg = JSON.parse(got);
    expect(msg.type).toBe("cf_agent_stream_resume_none");
  });
});
