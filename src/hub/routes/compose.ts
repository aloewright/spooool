import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { gateway } from "../lib/gateway";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { extrapolateVoiceProfile } from "../skills/blog/voice";

const blogVoiceSchema = z.object({
  links: z.array(z.string().url()).max(5).default([]),
  uploads: z
    .array(
      z.object({
        name: z.string().max(200).default(""),
        text: z.string().min(1).max(40_000),
      }),
    )
    .max(5)
    .default([]),
});

const loglineSchema = z.object({
  title: z.string().max(500).optional().default(""),
  protagonist: z.string().max(500).optional().default(""),
  conflict: z.string().max(500).optional().default(""),
  stakes: z.string().max(500).optional().default(""),
  type: z.enum(["fiction", "nonfiction"]).optional().default("fiction"),
});

export const composeRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
  .use("*", requireUser)
  .post("/logline", async (c) => {
    const body = loglineSchema.parse(await c.req.json());
    const system =
      body.type === "nonfiction"
        ? "You write one-sentence loglines for nonfiction books. Output ONE sentence in plain prose. No quotes, no preface, no labels. ≤30 words. Subject · tension · payoff. Vivid and specific, no clichés."
        : "Generate a one-sentence logline of a story that contains a description of a protagonist, the conflict or obstacle or journey they are going to take during the story, and the stakes involved if they are unsuccessful in their mission. Be descriptive yet concise. Avoid the use of any em-dashes and avoid using any clichés, idioms, or overused metaphors. Be conscious of the character arc the protagonist is going to go on during the story and hint at it. Output ONE sentence in plain prose. No quotes, no preface, no labels.";
    const titleHint = body.title ? ` The working title is "${body.title}".` : "";
    const user = `Generate a logline.${titleHint}`;
    const result = await gateway.chatCompletion(c.env, {
      route: "dynamic/text_gen",
      temperature: 0.85,
      maxTokens: 120,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const logline = result.text.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
    return c.json({ logline });
  })
  .post("/blog-voice", async (c) => {
    const body = blogVoiceSchema.parse(await c.req.json());
    if (body.links.length + body.uploads.length < 1) {
      return c.json({ error: "provide at least one example article (link or upload)" }, 400);
    }
    const result = await extrapolateVoiceProfile(c.env, body);
    return c.json(result);
  });
