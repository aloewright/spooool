import { motion, useReducedMotion } from "framer-motion";
import {
  BookOpen,
  Boxes,
  ChevronDown,
  FileText,
  Flag,
  Megaphone,
  Mic2,
  PackageCheck,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

const MODES = [
  { key: "concept", label: "Concept", icon: Search },
  { key: "voice", label: "Voice", icon: Mic2 },
  { key: "outline", label: "Outline", icon: Boxes },
  { key: "chapters", label: "Chapters", icon: FileText },
  { key: "book", label: "Book", icon: BookOpen },
  { key: "publish", label: "Publish", icon: PackageCheck },
  { key: "launch", label: "Launch", icon: Megaphone },
] as const;

const WORKFLOW_CHILDREN: Partial<
  Record<(typeof MODES)[number]["key"], readonly { key: string; label: string }[]>
> = {
  concept: [
    { key: "brief", label: "Concept brief" },
    { key: "scout", label: "Scout evidence" },
  ],
  voice: [
    { key: "library", label: "Voice library" },
    { key: "post-pilot", label: "Post Pilot imports" },
  ],
  outline: [
    { key: "setup", label: "Setup" },
    { key: "decisions", label: "Chapter board" },
    { key: "characters", label: "Characters" },
    { key: "chapters", label: "Generated" },
  ],
  chapters: [
    { key: "queue", label: "Draft queue" },
    { key: "sections", label: "Section drafts" },
  ],
  book: [
    { key: "manuscript", label: "Manuscript" },
    { key: "exports", label: "Exports" },
  ],
  publish: [
    { key: "metadata", label: "Metadata" },
    { key: "assets", label: "Assets" },
  ],
  launch: [
    { key: "handoff", label: "Handoff" },
    { key: "campaign", label: "Campaign" },
  ],
};

export type WorkflowKey = (typeof MODES)[number]["key"];
export type WorkflowStatus = "not-started" | "in-progress" | "needs-review" | "approved";

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "needs-review": "Needs review",
  approved: "Approved",
};

const STATUS_DOTS: Record<WorkflowStatus, string> = {
  "not-started": "bg-muted-foreground/35",
  "in-progress": "bg-blue-500",
  "needs-review": "bg-amber-500",
  approved: "bg-emerald-500",
};

export function OutlineRail({
  active = "concept",
  activeChild,
  statuses = {},
  onSelect,
}: {
  active?: WorkflowKey;
  activeChild?: string;
  statuses?: Partial<Record<WorkflowKey, WorkflowStatus>>;
  onSelect?: (mode: WorkflowKey, child?: string) => void;
}) {
  const activeMode = active;
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState<Partial<Record<WorkflowKey, boolean>>>(() => ({
    concept: true,
    [active]: true,
  }));

  useEffect(() => {
    setOpen((current) => ({ ...current, [activeMode]: true }));
  }, [activeMode]);

  return (
    <aside className="h-full min-h-0 w-full overflow-y-auto border-r bg-muted/30 p-3">
      <div className="mb-3 px-2">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          <Flag className="h-3 w-3" />
          Project
        </div>
      </div>
      <div className="flex flex-col gap-1" role="tree" aria-label="Project workflow">
        {MODES.map((m) => {
          const Icon = m.icon;
          const status = statuses[m.key] ?? "not-started";
          const children = WORKFLOW_CHILDREN[m.key] ?? [];
          const isOpen = open[m.key] ?? false;
          return (
            <div
              key={m.key}
              role="treeitem"
              aria-expanded={children.length ? isOpen : undefined}
              className="min-w-0"
            >
              <div className="grid grid-cols-[1fr_28px] gap-1">
                <button
                  type="button"
                  aria-label={`Go to ${m.label} workflow`}
                  title={`${m.label}: ${STATUS_LABELS[status]}`}
                  onClick={() => onSelect?.(m.key)}
                  className={cn(
                    "relative grid w-full grid-cols-[20px_1fr_auto] items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    activeMode === m.key
                      ? "text-primary-foreground"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  {activeMode === m.key ? (
                    <motion.span
                      layoutId="workflow-active-indicator"
                      className="absolute inset-0 rounded-md bg-primary"
                      transition={
                        reduceMotion
                          ? { duration: 0 }
                          : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }
                      }
                      aria-hidden
                    />
                  ) : null}
                  <Icon className="relative h-4 w-4" aria-hidden />
                  <span className="relative min-w-0 truncate">{m.label}</span>
                  <span
                    aria-label={STATUS_LABELS[status]}
                    className={cn(
                      "relative h-2 w-2 rounded-full transition-colors",
                      activeMode === m.key ? "bg-primary-foreground/80" : STATUS_DOTS[status],
                    )}
                  />
                </button>
                {children.length ? (
                  <button
                    type="button"
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${m.label}`}
                    className="grid h-9 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => setOpen((current) => ({ ...current, [m.key]: !isOpen }))}
                  >
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", isOpen ? "" : "-rotate-90")}
                      aria-hidden
                    />
                  </button>
                ) : null}
              </div>
              {children.length && isOpen ? (
                <div className="ml-[18px] mt-1 border-l pl-2">
                  {children.map((child) => {
                    const childActive = activeMode === m.key && activeChild === child.key;
                    return (
                      <button
                        key={child.key}
                        type="button"
                        aria-label={`Go to ${m.label} ${child.label}`}
                        onClick={() => onSelect?.(m.key, child.key)}
                        className={cn(
                          "grid w-full grid-cols-[8px_1fr] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                          childActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            childActive ? "bg-primary" : "bg-muted-foreground/35",
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">{child.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
