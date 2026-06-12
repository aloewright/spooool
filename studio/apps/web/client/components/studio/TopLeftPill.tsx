import { PanelLeft } from "lucide-react";
import { useDrawerLayout } from "../../lib/drawer-layout";

export function TopLeftPill() {
  const { open, setOpen } = useDrawerLayout();
  if (open) return null;
  return (
    <div className="pointer-events-auto fixed top-4 left-4 z-40 flex items-center gap-1 rounded-full bg-neutral-950/90 px-2 py-1.5 text-neutral-200 shadow-lg ring-1 ring-white/5 backdrop-blur">
      <button
        aria-label="Open drawer"
        className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        onClick={() => setOpen(true)}
        type="button"
      >
        <PanelLeft className="size-4" />
      </button>
    </div>
  );
}
