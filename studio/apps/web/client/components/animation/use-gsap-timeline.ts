import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { type RefObject, useEffect, useState } from "react";

gsap.registerPlugin(useGSAP);

export function useGsapTimeline<T extends HTMLElement>(
  scope: RefObject<T | null>,
  build: (timeline: gsap.core.Timeline, scope: T) => void,
  dependencies: unknown[] = [],
) {
  const reduceMotion = usePrefersReducedMotion();

  useGSAP(
    () => {
      const node = scope.current;
      if (!node || reduceMotion) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out", duration: 0.32 } });
      build(timeline, node);
      return () => timeline.kill();
    },
    { scope, dependencies: [reduceMotion, ...dependencies] },
  );
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(media.matches);
    const handleChange = () => setReduced(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return reduced;
}
