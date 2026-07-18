import { Audio } from "@remotion/media";
import type { ReactElement, ReactNode } from "react";
import { staticFile } from "remotion";
import { describe, expect, it } from "vitest";
import { DEMO_ASSETS } from "./demo-assets";
import { DEMO_THEME } from "./demo-theme";
import {
  DEMO_BRAND_NAME,
  DEMO_COPY,
  DEMO_SCENE_COPY,
  DEMO_SCENES,
  SpoooolDemo,
} from "./SpoooolDemo";
import { BrandWordmarkReveal } from "./scenes/BrandScene";
import { REFINE_EXCERPT_MIN_HEIGHT } from "./scenes/RefineScene";

type CompositionTree = ReactElement<{
  children: readonly [readonly ReactElement[], ReactElement];
}>;

const ASSEMBLY_CASES = [
  {
    format: "landscape",
    scenes: [
      { from: 0, duration: 90, transitionInFrames: 0 },
      { from: 75, duration: 165, transitionInFrames: 15 },
      { from: 225, duration: 195, transitionInFrames: 15 },
      { from: 405, duration: 225, transitionInFrames: 15 },
      { from: 615, duration: 165, transitionInFrames: 15 },
      { from: 765, duration: 135, transitionInFrames: 15 },
    ],
  },
  {
    format: "vertical",
    scenes: [
      { from: 0, duration: 60, transitionInFrames: 0 },
      { from: 45, duration: 135, transitionInFrames: 15 },
      { from: 165, duration: 165, transitionInFrames: 15 },
      { from: 315, duration: 165, transitionInFrames: 15 },
      { from: 465, duration: 105, transitionInFrames: 15 },
      { from: 555, duration: 105, transitionInFrames: 15 },
    ],
  },
] as const;

describe("SpoooolDemo", () => {
  it("reserves two text lines for the landscape refinement excerpt", () => {
    expect(REFINE_EXCERPT_MIN_HEIGHT.landscape).toBeGreaterThanOrEqual(
      40 * 1.22 * 2,
    );
    expect(REFINE_EXCERPT_MIN_HEIGHT.vertical).toBeGreaterThanOrEqual(
      49 * 1.22 * 2,
    );
  });

  it("keeps the approved product-film copy exact", () => {
    expect(DEMO_COPY).toEqual([
      "An idea.",
      "Start with a spark.",
      "Give it shape.",
      "Make every word count.",
      "Ready when you are.",
      "Where ideas become stories.",
      "spooool.com/studio",
    ]);
    expect(DEMO_BRAND_NAME).toBe("Spooool");
    expect(DEMO_SCENE_COPY).toEqual({
      spark: "An idea.",
      compose: "Start with a spark.",
      shape: "Give it shape.",
      refine: "Make every word count.",
      publish: "Ready when you are.",
      brand: {
        tagline: "Where ideas become stories.",
        url: "spooool.com/studio",
      },
    });
  });

  it("registers exactly the six approved scenes", () => {
    expect(Object.keys(DEMO_SCENES)).toEqual([
      "spark",
      "compose",
      "shape",
      "refine",
      "publish",
      "brand",
    ]);
  });

  it.each(["landscape", "vertical"] as const)(
    "draws the %s wordmark with the amber thread reveal",
    (format) => {
      const wordmark = BrandWordmarkReveal({
        format,
        drawProgress: 0.5,
        fillProgress: 0,
      }) as ReactElement<{
        children: readonly ReactElement[];
        "aria-label": string;
      }>;
      const [definitions, thread, outline, fill] = wordmark.props.children;
      const clipPath = definitions.props.children as ReactElement;
      const reveal = clipPath.props.children as ReactElement;

      expect(wordmark.props["aria-label"]).toBe("Spooool wordmark");
      expect(thread.type).toBe("path");
      expect(thread.props.stroke).toBe(DEMO_THEME.amber);
      expect(outline.type).toBe("text");
      expect(outline.props.children).toBe(DEMO_BRAND_NAME);
      expect(outline.props.fill).toBe("none");
      expect(outline.props.stroke).toBe(DEMO_THEME.amber);
      expect(outline.props.clipPath).toBe(
        `url(#brand-wordmark-reveal-${format})`,
      );
      expect(reveal.type).toBe("rect");
      expect(reveal.props.width).toBeGreaterThan(0);
      expect(reveal.props.width).toBeLessThan(780);
      expect(fill.props.children).toBe(DEMO_BRAND_NAME);
      expect(fill.props.opacity).toBe(0);
    },
  );

  it.each(ASSEMBLY_CASES)(
    "assembles the exact $format scene and audio tree",
    ({ format, scenes: expectedScenes }) => {
      const tree = SpoooolDemo({ format }) as CompositionTree;
      const [sequences, audio] = tree.props.children;

      expect(sequences).toHaveLength(6);
      expect(
        sequences.map((sequence) => ({
          from: sequence.props.from,
          durationInFrames: sequence.props.durationInFrames,
          premountFor: sequence.props.premountFor,
        })),
      ).toEqual(
        expectedScenes.map((scene) => ({
          from: scene.from,
          durationInFrames: scene.duration,
          premountFor: 30,
        })),
      );

      expect(
        sequences.map((sequence) => {
          const transition = sequence.props.children as ReactElement<{
            children: ReactElement<{
              format: string;
              durationInFrames: number;
            }>;
            transitionInFrames: number;
          }>;
          const scene = transition.props.children;

          return {
            transitionInFrames: transition.props.transitionInFrames,
            format: scene.props.format,
            durationInFrames: scene.props.durationInFrames,
          };
        }),
      ).toEqual(
        expectedScenes.map((scene) => ({
          transitionInFrames: scene.transitionInFrames,
          format,
          durationInFrames: scene.duration,
        })),
      );

      expect(audio.type).toBe(Audio);
      expect(audio.props.src).toBe(staticFile(DEMO_ASSETS.audio[format]));
      expect(audio.props.children as ReactNode).toBeUndefined();
    },
  );
});
