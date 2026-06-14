import { MessageCircle, PanelRightClose } from "lucide-react";
import { useEffect, useState } from "react";
import { useDrawerLayout } from "../../lib/drawer-layout";
import { EditorialAssistantSidecar } from "../chat/aloysius-sidecar";

export function AssistantPanel({ projectId }: { projectId: string }) {
  const { chatOpen, setChatOpen } = useDrawerLayout();

  // Mount the sidecar lazily — once on first open — and then keep it
  // mounted so the WebSocket + chat state survive minimize/maximize cycles.
  // Closing the panel only hides it visually; it does NOT remount.
  const [hasOpenedOnce, setHasOpenedOnce] = useState(chatOpen);
  useEffect(() => {
    if (chatOpen) setHasOpenedOnce(true);
  }, [chatOpen]);

  return (
    <>
      {!chatOpen && (
        <div className="fixed right-4 bottom-4 z-[60]">
          <button
            aria-label="Open chat"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-neutral-950/95 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur hover:bg-neutral-900"
            onClick={() => setChatOpen(true)}
            title="Open chat"
            type="button"
          >
            <MessageCircle className="size-5" />
          </button>
        </div>
      )}

      {hasOpenedOnce && (
        <aside
          aria-hidden={!chatOpen}
          aria-label="Editorial assistant chat"
          className={`fixed right-4 bottom-4 z-[60] flex h-[min(560px,calc(100vh-2rem))] w-80 flex-col overflow-hidden rounded-3xl bg-neutral-950/95 text-neutral-200 shadow-2xl ring-1 ring-white/5 backdrop-blur transition-all duration-300 ${
            chatOpen ? "" : "pointer-events-none hidden"
          }`}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-white/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <MessageCircle className="size-4" />
              <span className="font-medium text-sm">Chat</span>
            </div>
            <button
              aria-label="Minimize chat"
              className="rounded-md p-1 hover:bg-white/10"
              onClick={() => setChatOpen(false)}
              title="Minimize"
              type="button"
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <EditorialAssistantSidecar projectId={projectId} />
          </div>
        </aside>
      )}
    </>
  );
}
