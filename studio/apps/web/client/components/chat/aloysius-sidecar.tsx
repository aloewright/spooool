import {
  CHAT_MODEL_ROUTES,
  type ChatModelRouteId,
  DEFAULT_CHAT_MODEL_ROUTE,
  resolveChatModelRoute,
} from "@/shared/chat-models";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useQuery } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { Send, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { api, queryKeys } from "../../lib/api";
import { appBase } from "../../lib/app-base";

type ChatHistoryItem = { role: "user" | "assistant"; text: string };

export function EditorialAssistantSidecar({ projectId }: { projectId: string }) {
  // Pre-load the chat history through our own endpoint via TanStack Query so
  // we (a) get caching/dedup and (b) can hand the messages to useAgentChat as
  // its initial state. We also tell useAgentChat to skip the SDK's own
  // /get-messages fetch (`getInitialMessages: null`) — otherwise we'd see two
  // GETs to /agents/aloysius/{id}/get-messages on every mount, which is the
  // "double load" symptom we hit before.
  const history = useQuery({
    queryKey: queryKeys.projectChat(projectId),
    queryFn: () => api.getProjectChat(projectId),
    // Keep history fresh across tab focus so a reply that arrived in another
    // tab shows up when this one regains focus; the WebSocket also pushes
    // updates while mounted, so this is mostly a safety net.
    staleTime: 30_000,
  });

  if (history.isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <p className="font-serif text-neutral-500 text-sm">Loading chat…</p>
      </div>
    );
  }

  return (
    <ChatPanel initialItems={history.data?.items ?? []} key={projectId} projectId={projectId} />
  );
}

function ChatPanel({
  projectId,
  initialItems,
}: {
  projectId: string;
  initialItems: ChatHistoryItem[];
}) {
  // Which gateway route the assistant runs on. The agent's persisted state is
  // the source of truth; onStateUpdate keeps this in sync on connect and when
  // another tab changes it.
  const [modelRoute, setModelRoute] = useState<ChatModelRouteId>(DEFAULT_CHAT_MODEL_ROUTE);

  // Stable identity for useAgent so the WebSocket isn't reconnected on every
  // render of the parent. When the app is served via spooool.com/studio, the
  // socket URL needs the prefix too (the worker strips it before routing).
  const agentOpts = useMemo(
    () => ({
      agent: "aloysius",
      name: projectId,
      ...(appBase ? { basePath: `${appBase.slice(1)}/agents/aloysius/${projectId}` } : {}),
      onStateUpdate: (state: { model_route?: unknown } | null) => {
        setModelRoute(resolveChatModelRoute(state?.model_route));
      },
    }),
    [projectId],
  );
  const agent = useAgent(agentOpts);

  function selectModelRoute(route: ChatModelRouteId) {
    setModelRoute(route);
    agent.setState({ model_route: route });
  }

  // Map our compact history shape into the UIMessage shape useAgentChat
  // expects. Computed once on mount — useAgentChat takes `messages` as the
  // initial state and manages its own list from then on.
  const initialMessages = useMemo<UIMessage[]>(
    () =>
      initialItems.map((item, idx) => ({
        id: `history-${idx}`,
        role: item.role,
        parts: [{ type: "text", text: item.text }],
      })),
    [initialItems],
  );

  const { messages, sendMessage, status, stop } = useAgentChat({
    agent,
    messages: initialMessages,
    // Skip the SDK's HTTP hydrate — we already supplied messages above.
    getInitialMessages: null,
  });

  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const smoothScrollReady = useRef(false);

  const isStreaming = status === "streaming" || status === "submitted";

  const messageScrollKey = useMemo(
    () =>
      messages
        .map((message) => {
          const textLength = message.parts
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .reduce((sum, part) => sum + part.text.length, 0);
          return `${message.id}:${textLength}`;
        })
        .join("|"),
    [messages],
  );

  useEffect(() => {
    const sock = agent as unknown as WebSocket;
    if (!sock || typeof sock.addEventListener !== "function") return;
    const update = () => setConnected(sock.readyState === WebSocket.OPEN);
    update();
    sock.addEventListener("open", update);
    sock.addEventListener("close", update);
    return () => {
      sock.removeEventListener("open", update);
      sock.removeEventListener("close", update);
    };
  }, [agent]);

  useEffect(() => {
    void messageScrollKey;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: smoothScrollReady.current ? "smooth" : "auto",
    });
    if (smoothScrollReady.current) return;
    const id = window.setTimeout(() => {
      smoothScrollReady.current = true;
    }, 250);
    return () => window.clearTimeout(id);
  }, [messageScrollKey]);

  function submit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="py-10 text-center font-serif text-neutral-500 text-sm leading-relaxed">
            Ask anything about your book — craft, structure, character, voice.
          </p>
        )}

        {messages.map((m) => {
          const isUser = m.role === "user";
          const text = m.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");
          if (isUser) {
            return (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] rounded-2xl bg-white/10 px-3 py-2 text-neutral-200 text-sm whitespace-pre-wrap"
              >
                {text}
              </div>
            );
          }
          return (
            <div
              key={m.id}
              className="max-w-[92%] font-serif text-neutral-300 text-sm leading-relaxed"
            >
              <Streamdown>{text}</Streamdown>
            </div>
          );
        })}

        {status === "submitted" && (
          <div className="flex items-center gap-1 py-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/5 p-3">
        <div className="relative">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isStreaming ? "Replying…" : "Ask anything…"}
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none rounded-xl bg-white/5 px-3 py-2 pr-10 text-neutral-200 text-sm outline-none placeholder:text-neutral-500 transition focus:bg-white/8"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onInput={(e) => {
              const ta = e.currentTarget;
              ta.style.height = "auto";
              ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
            }}
          />
          <div className="absolute right-2 bottom-2">
            {isStreaming ? (
              <button
                aria-label="Stop"
                className="grid size-6 place-items-center rounded-lg bg-white/10 hover:bg-white/20"
                onClick={stop}
                type="button"
              >
                <Square className="size-3" />
              </button>
            ) : (
              <button
                aria-label="Send"
                className="grid size-6 place-items-center rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
                disabled={!input.trim()}
                onClick={submit}
                type="button"
              >
                <Send className="size-3" />
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-neutral-600"}`}
          />
          <span className="text-[10px] text-neutral-500">
            {connected ? "Connected" : "Connecting…"}
          </span>
          <div aria-label="Model" className="ml-auto flex items-center gap-1">
            {CHAT_MODEL_ROUTES.map((route) => (
              <button
                aria-pressed={modelRoute === route.id}
                className={`rounded-full px-2 py-0.5 text-[10px] transition disabled:opacity-40 ${
                  modelRoute === route.id
                    ? "bg-emerald-600/20 text-emerald-400"
                    : "text-neutral-500 hover:bg-white/5 hover:text-neutral-300"
                }`}
                // Until the socket is open, a selection can be dropped and then
                // overwritten by the server's persisted state on connect.
                disabled={!connected}
                key={route.id}
                onClick={() => selectModelRoute(route.id)}
                title={route.description}
                type="button"
              >
                {route.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
