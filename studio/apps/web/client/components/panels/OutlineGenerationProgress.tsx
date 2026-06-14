import { useRef } from "react";
import { useGsapTimeline } from "../animation/use-gsap-timeline";

export default function OutlineGenerationProgress() {
  const ref = useRef<HTMLDivElement | null>(null);
  const steps = ["Architecting outline", "Building chapter skeletons", "Preparing manuscript path"];

  useGsapTimeline(
    ref,
    (timeline, node) => {
      timeline
        .fromTo(
          node.querySelector("[data-progress-bar]"),
          { scaleX: 0, transformOrigin: "left center" },
          { scaleX: 1, duration: 1.2 },
        )
        .fromTo(
          node.querySelectorAll("[data-progress-step]"),
          { opacity: 0.45, y: 4 },
          { opacity: 1, y: 0, stagger: 0.12 },
          0,
        );
    },
    [],
  );

  return (
    <div ref={ref} className="rounded-md border bg-muted/20 p-3" aria-live="polite">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div data-progress-bar className="h-full rounded-full bg-primary" />
      </div>
      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
        {steps.map((step) => (
          <div key={step} data-progress-step className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}
