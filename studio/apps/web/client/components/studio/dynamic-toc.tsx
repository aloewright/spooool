import { AnimatePresence, type Transition, motion } from "framer-motion";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";

type HeadingData = { id: string; text: string; level: number; element: HTMLElement };

const islandTransition: Transition = {
  type: "tween",
  ease: [0.22, 1, 0.36, 1],
  duration: 0.5,
};

function CircleProgress({ percentage }: { percentage: number }) {
  const size = 24;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  return (
    <svg
      aria-label="Reading progress"
      className="-rotate-90 shrink-0"
      height={size}
      role="img"
      width={size}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        stroke="var(--muted)"
        strokeWidth={strokeWidth}
      />
      <motion.circle
        animate={{ strokeDashoffset: offset }}
        cx={size / 2}
        cy={size / 2}
        fill="none"
        initial={{ strokeDashoffset: circumference }}
        r={radius}
        stroke="var(--foreground)"
        strokeDasharray={circumference}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
        transition={{ duration: 0.15, ease: "easeOut" }}
      />
    </svg>
  );
}

type Props = {
  children?: ReactNode;
  selector?: string;
  scrollContainer?: HTMLElement | null;
};

export function DynamicIslandTOC({ children, selector = "[data-toc]", scrollContainer }: Props) {
  const [headings, setHeadings] = useState<HeadingData[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const getHeadings = () => {
      const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      const valid = elements
        .filter((el) => !el.hasAttribute("data-toc-ignore"))
        .map((el, index) => {
          if (!el.id) {
            const generatedId =
              el.textContent
                ?.toLowerCase()
                .replace(/\s+/g, "-")
                .replace(/[^\w-]/g, "") || `toc-heading-${index}`;
            el.id = generatedId;
          }
          const depthAttr = el.getAttribute("data-toc-depth");
          let level = 2;
          if (depthAttr) level = Number.parseInt(depthAttr, 10);
          else {
            const tag = el.tagName.toUpperCase();
            if (tag.startsWith("H") && tag.length === 2) level = Number.parseInt(tag[1], 10);
          }
          const text = el.getAttribute("data-toc-title") || el.textContent || "Section";
          return { id: el.id, text, level, element: el };
        });
      valid.sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      setHeadings(valid);
    };
    const t = setTimeout(getHeadings, 100);
    return () => clearTimeout(t);
  }, [selector]);

  useEffect(() => {
    const target: HTMLElement | Window = scrollContainer ?? window;
    const handleScroll = () => {
      let currentActiveId: string | null = null;
      for (const h of headings) {
        const top = h.element.getBoundingClientRect().top;
        if (top <= 120) currentActiveId = h.id;
        else break;
      }
      if (!currentActiveId && headings.length > 0) currentActiveId = headings[0].id;
      setActiveId(currentActiveId);
      const isWindow = target === window;
      const scrollTop = isWindow ? window.scrollY : (target as HTMLElement).scrollTop;
      const scrollHeight = isWindow
        ? document.documentElement.scrollHeight
        : (target as HTMLElement).scrollHeight;
      const clientHeight = isWindow ? window.innerHeight : (target as HTMLElement).clientHeight;
      const total = scrollHeight - clientHeight;
      setProgress(total > 0 ? Math.min(100, Math.max(0, (scrollTop / total) * 100)) : 0);
    };
    target.addEventListener("scroll", handleScroll, { passive: true } as AddEventListenerOptions);
    handleScroll();
    return () => target.removeEventListener("scroll", handleScroll);
  }, [headings, scrollContainer]);

  const activeHeading = headings.find((h) => h.id === activeId);
  const minLevel = useMemo(() => {
    if (headings.length === 0) return 1;
    return Math.min(...headings.map((h) => h.level));
  }, [headings]);

  return (
    <>
      {children}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-[9998] bg-black/20 backdrop-blur-[4px]"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            onClick={() => setIsExpanded(false)}
            transition={islandTransition}
          />
        )}
      </AnimatePresence>
      <motion.div
        animate={{ y: 0, opacity: 1 }}
        className="-translate-x-1/2 fixed bottom-[30px] left-1/2 z-[9999] flex flex-col items-center"
        initial={{ y: 50, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
      >
        <motion.div
          animate={{
            width: isExpanded ? 340 : 280,
            height: isExpanded ? 400 : 52,
            borderRadius: isExpanded ? 24 : 26,
          }}
          className="relative overflow-hidden border border-foreground/10 bg-background text-foreground shadow-2xl"
          initial={false}
          onClick={() => {
            if (!isExpanded) setIsExpanded(true);
          }}
          style={{ cursor: isExpanded ? "default" : "pointer" }}
          transition={islandTransition}
        >
          <motion.div
            animate={{
              opacity: isExpanded ? 0 : 1,
              scale: isExpanded ? 0.95 : 1,
              filter: isExpanded ? "blur(4px)" : "blur(0px)",
            }}
            className={cn(
              "absolute inset-0 flex items-center gap-4 px-4 sm:px-5",
              isExpanded && "pointer-events-none",
            )}
            initial={false}
            transition={{ ...islandTransition, delay: isExpanded ? 0 : 0.1 }}
          >
            <div className="h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <div className="relative flex h-full flex-1 items-center overflow-hidden text-left">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  animate={{ opacity: 1, y: 0 }}
                  className="block w-full overflow-hidden text-ellipsis whitespace-nowrap font-medium text-foreground text-sm"
                  exit={{ opacity: 0, y: -15 }}
                  initial={{ opacity: 0, y: 15 }}
                  key={activeId || "empty"}
                  transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                >
                  {activeHeading?.text || "Contents"}
                </motion.span>
              </AnimatePresence>
            </div>
            <CircleProgress percentage={progress} />
          </motion.div>

          <motion.div
            animate={{ opacity: isExpanded ? 1 : 0, scale: isExpanded ? 1 : 1.05 }}
            className={cn("absolute inset-0 flex flex-col", !isExpanded && "pointer-events-none")}
            initial={false}
            transition={{ ...islandTransition, delay: isExpanded ? 0.1 : 0 }}
          >
            <div className="flex shrink-0 items-center justify-between px-6 pt-5 pb-3">
              <span className="font-semibold text-[11px] text-muted-foreground tracking-[0.08em]">
                STEPS
              </span>
              <button
                className="text-muted-foreground transition-colors hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(false);
                }}
                type="button"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
              <div className="flex flex-col gap-0.5">
                {headings.map((h, idx) => {
                  const isActive = activeId === h.id;
                  const isHovered = hoveredId === h.id;
                  const indent = Math.max(0, h.level - minLevel);
                  const paddingLeft = indent * 14 + 12;
                  const isTopLevel = h.level === minLevel;
                  return (
                    <button
                      className={cn(
                        "group flex w-full shrink-0 cursor-pointer items-center rounded-lg border-none py-2 pr-3 text-left text-sm transition-all duration-300 ease-out",
                        isActive && "bg-foreground/10 font-medium text-foreground",
                        !isActive && isHovered && "bg-foreground/5 text-foreground/85",
                        !isActive && !isHovered && "bg-transparent text-foreground/45",
                      )}
                      key={h.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        const yOffset = -80;
                        const container = scrollContainer;
                        if (container) {
                          const top =
                            h.element.getBoundingClientRect().top -
                            container.getBoundingClientRect().top +
                            container.scrollTop +
                            yOffset;
                          container.scrollTo({ top, behavior: "smooth" });
                        } else {
                          const y =
                            h.element.getBoundingClientRect().top + window.scrollY + yOffset;
                          window.scrollTo({ top: y, behavior: "smooth" });
                        }
                        setIsExpanded(false);
                      }}
                      onMouseEnter={() => setHoveredId(h.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      style={{ paddingLeft: `${paddingLeft}px` }}
                      type="button"
                    >
                      {isTopLevel && (
                        <span
                          className={cn(
                            "mr-2 inline-flex w-5 shrink-0 justify-center font-mono text-[10px] tabular-nums",
                            isActive ? "text-foreground/70" : "text-foreground/35",
                          )}
                        >
                          {idx + 1}
                        </span>
                      )}
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap transition-transform duration-300 group-hover:translate-x-1">
                        {h.text}
                      </span>
                      <motion.div
                        animate={{ scale: isActive ? 1 : 0, opacity: isActive ? 1 : 0 }}
                        className="ml-3 h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
                        initial={false}
                        transition={{ duration: 0.3, ease: "easeOut" }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </motion.div>
      </motion.div>
    </>
  );
}
