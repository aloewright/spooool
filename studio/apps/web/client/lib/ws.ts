export type EditorialAssistantEvent =
  | { type: "hello"; from: string }
  | { type: "assistant_message"; text: string }
  | { type: "assistant_chunk"; text: string }
  | { type: "assistant_done" }
  | { type: "pong" }
  | { type: "job_status"; job_id: string; kind: string; status: string };

export function connectEditorialAssistant(projectId: string): {
  ws: WebSocket;
  send: (msg: object) => void;
  onEvent: (cb: (e: EditorialAssistantEvent) => void) => () => void;
} {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/agents/aloysius/${projectId}`);
  const listeners = new Set<(e: EditorialAssistantEvent) => void>();
  ws.addEventListener("message", (ev) => {
    const data = JSON.parse(String(ev.data)) as EditorialAssistantEvent;
    for (const listener of listeners) listener(data);
  });
  return {
    ws,
    send: (msg) => {
      const json = JSON.stringify(msg);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      } else {
        ws.addEventListener("open", () => ws.send(json), { once: true });
      }
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
