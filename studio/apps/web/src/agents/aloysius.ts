import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from "ai";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { projects } from "../db/schema";
import type { Env } from "../env";
import {
  type ChatModelRouteId,
  DEFAULT_CHAT_MODEL_ROUTE,
  resolveChatModelRoute,
} from "../shared/chat-models";
import { buildProjectBriefPrompt } from "../shared/project-brief";

export type BookProjectAgentState = {
  model_route: ChatModelRouteId;
};

const SYSTEM_PROMPT = `You are Book Cook's Editorial Assistant, an expert editor and publishing strategist embedded inside the Book Cook platform. You help authors write, structure, and publish Kindle + Audible books.

Your personality: precise, warm, commercially-minded. You think like an editor who also knows the Amazon algorithms.

When a user starts a conversation, briefly introduce yourself and ask what they're working on. Keep responses concise — this is a chat interface, not a document. Use markdown — short paragraphs, bullet points for lists, bold for emphasis. Never hallucinate facts about the book beyond what the author has told you or what the project brief below states.`;

export class BookProjectAgent extends AIChatAgent<Env & { ENV: "dev" }, BookProjectAgentState> {
  maxPersistedMessages = 100;

  // Synced to the chat UI over the agent WebSocket and persisted per project,
  // so the selection sticks across sessions.
  initialState: BookProjectAgentState = { model_route: DEFAULT_CHAT_MODEL_ROUTE };

  async onChatMessage(_onFinish: unknown, _options?: OnChatMessageOptions) {
    if (!this.env.AI_GATEWAY_BASE_URL || !this.env.AI_GATEWAY_TOKEN) {
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            const id = crypto.randomUUID();
            writer.write({ type: "text-start", id });
            writer.write({
              type: "text-delta",
              id,
              delta:
                "Book Cook's Editorial Assistant is running in local mode. I can still help shape this chapter, and section drafting is available from the editor panel.",
            });
            writer.write({ type: "text-end", id });
          },
        }),
      });
    }

    const provider = createOpenAICompatible({
      name: "cfaig",
      baseURL: this.env.AI_GATEWAY_BASE_URL.replace(/\/$/, ""),
      headers: {
        "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
        "cf-aig-zdr": "true",
      },
    });

    // State is client-writable over the WebSocket — clamp to known routes.
    const result = streamText({
      model: provider.chatModel(resolveChatModelRoute(this.state?.model_route)),
      system: SYSTEM_PROMPT + (await this.projectBrief()),
      messages: await convertToModelMessages(this.messages),
    });

    return result.toUIMessageStreamResponse();
  }

  // The agent instance name is the project id, so the assistant can read the
  // author's compose-wizard answers (logline, genre, audience, voice) from D1
  // and ground its replies in them. Re-read per message so edits show up.
  private async projectBrief(): Promise<string> {
    try {
      const db = drizzle(this.env.DB);
      const [p] = await db.select().from(projects).where(eq(projects.id, this.name)).limit(1);
      return p ? `\n\n${buildProjectBriefPrompt(p)}` : "";
    } catch (err) {
      console.error("aloysius: project brief lookup failed", err);
      return "";
    }
  }

  async notifyJobStatus(_jobId: string): Promise<void> {
    // Wired up in Publisher phase.
  }
}
