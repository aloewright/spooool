import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge";

export default function DisclosureSection({
  title,
  description,
  open,
  onOpenChange,
  children,
  icon,
  meta,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  icon?: ReactNode;
  meta?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <section className="overflow-hidden rounded-xl border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 bg-background/70 p-4 text-left transition-colors hover:bg-accent/40"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex min-w-0 gap-3">
          {icon}
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{title}</span>
            {description ? (
              <span className="mt-1 block text-sm text-muted-foreground">{description}</span>
            ) : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {meta ? <Badge variant="secondary">{meta}</Badge> : null}
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="border-t p-4"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
