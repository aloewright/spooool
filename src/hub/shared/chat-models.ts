// Model routes the Editorial Assistant chat can run on. Shared by the
// BookProjectAgent (route selection + validation) and the chat sidecar UI.
// Each id is a Cloudflare AI Gateway dynamic route; the model behind it is
// configured in the gateway dashboard, never in this codebase.

export type ChatModelRouteId = "dynamic/text_gen" | "dynamic/fable_gen";

export type ChatModelRoute = {
  id: ChatModelRouteId;
  label: string;
  description: string;
};

export const CHAT_MODEL_ROUTES: ChatModelRoute[] = [
  {
    id: "dynamic/text_gen",
    label: "Standard",
    description: "The default editorial model — fast and economical.",
  },
  {
    id: "dynamic/fable_gen",
    label: "Fable",
    description: "Claude Fable 5 — deepest reasoning for the hardest editorial work.",
  },
];

export const DEFAULT_CHAT_MODEL_ROUTE: ChatModelRouteId = "dynamic/text_gen";

/** Clamps untrusted input (agent state is client-writable) to a known route. */
export function resolveChatModelRoute(value: unknown): ChatModelRouteId {
  return CHAT_MODEL_ROUTES.some((r) => r.id === value)
    ? (value as ChatModelRouteId)
    : DEFAULT_CHAT_MODEL_ROUTE;
}
