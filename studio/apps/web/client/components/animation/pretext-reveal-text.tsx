import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { motion, useReducedMotion } from "framer-motion";
import { type ElementType, useMemo } from "react";

type PretextRevealTextProps = {
  text: string;
  as?: ElementType;
  className?: string;
  font?: string;
  lineHeight?: number;
  delay?: number;
  minWidthToAnimate?: number;
  stagger?: number;
  children?: never;
};

export function PretextRevealText({
  text,
  as: Tag = "span",
  className,
  font = "14px Nunito, ui-sans-serif, system-ui, sans-serif",
  delay = 0,
}: PretextRevealTextProps) {
  const reduceMotion = useReducedMotion();
  const naturalWidth = useMemo(() => {
    if (!text.trim()) return undefined;
    try {
      return Math.ceil(measureNaturalWidth(prepareWithSegments(text, font)));
    } catch {
      return undefined;
    }
  }, [font, text]);

  if (reduceMotion || !text.trim()) {
    return (
      <Tag className={className} data-pretext-natural-width={naturalWidth}>
        {text}
      </Tag>
    );
  }

  return (
    <Tag className={className} data-pretext-natural-width={naturalWidth}>
      <motion.span
        className="inline"
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.14,
          delay,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        {text}
      </motion.span>
    </Tag>
  );
}
