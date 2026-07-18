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
import * as RefineSceneModule from "./scenes/RefineScene";
import { REFINE_EXCERPT_MIN_HEIGHT } from "./scenes/RefineScene";
import { toLogicalSceneFrame } from "./demo-motion";

type CompositionTree = ReactElement<{
  children: readonly [readonly ReactElement[], ReactElement];
}>;

const ASSEMBLY_CASES = [
  {
    format: "landscape",
    scenes: [
      { canonicalFrom: 0, duration: 90, renderFrom: 0, renderDuration: 90, renderOffset: 0 },
      { canonicalFrom: 90, duration: 150, renderFrom: 75, renderDuration: 165, renderOffset: 15 },
      { canonicalFrom: 240, duration: 180, renderFrom: 225, renderDuration: 195, renderOffset: 15 },
      { canonicalFrom: 420, duration: 210, renderFrom: 405, renderDuration: 225, renderOffset: 15 },
      { canonicalFrom: 630, duration: 150, renderFrom: 615, renderDuration: 165, renderOffset: 15 },
      { canonicalFrom: 780, duration: 120, renderFrom: 765, renderDuration: 135, renderOffset: 15 },
    ],
  },
  {
    format: "vertical",
    scenes: [
      { canonicalFrom: 0, duration: 60, renderFrom: 0, renderDuration: 60, renderOffset: 0 },
      { canonicalFrom: 60, duration: 120, renderFrom: 45, renderDuration: 135, renderOffset: 15 },
      { canonicalFrom: 180, duration: 150, renderFrom: 165, renderDuration: 165, renderOffset: 15 },
      { canonicalFrom: 330, duration: 150, renderFrom: 315, renderDuration: 165, renderOffset: 15 },
      { canonicalFrom: 480, duration: 90, renderFrom: 465, renderDuration: 105, renderOffset: 15 },
      { canonicalFrom: 570, duration: 90, renderFrom: 555, renderDuration: 105, renderOffset: 15 },
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

  it("uses intrinsic grid measurement so neither refinement excerpt can clip", () => {
    expect(RefineSceneModule.RefineExcerpt).toBeTypeOf("function");

    const excerpt = RefineSceneModule.RefineExcerpt({
      format: "landscape",
      refineProgress: 0.5,
    }) as ReactElement<{ children: readonly ReactElement[]; style: Record<string, unknown> }>;
    const excerpts = excerpt.props.children;

    expect(excerpt.props.style.display).toBe("grid");
    expect(excerpts).toHaveLength(2);
    expect(
      excerpts.map(({ props }) => ({
        gridArea: props.style.gridArea,
        overflow: props.style.overflow,
      })),
    ).toEqual([
      { gridArea: "1 / 1", overflow: undefined },
      { gridArea: "1 / 1", overflow: undefined },
    ]);
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
          from: scene.renderFrom,
          durationInFrames: scene.renderDuration,
          premountFor: 30,
        })),
      );

      expect(
        sequences.map((sequence) => {
          const transition = sequence.props.children as ReactElement<{
            children: ReactElement<{
              format: string;
              durationInFrames: number;
              renderOffset: number;
            }>;
            transitionInFrames: number;
          }>;
          const scene = transition.props.children;

          return {
            transitionInFrames: transition.props.transitionInFrames,
            format: scene.props.format,
            durationInFrames: scene.props.durationInFrames,
            renderOffset: scene.props.renderOffset,
          };
        }),
      ).toEqual(
        expectedScenes.map((scene) => ({
          transitionInFrames: scene.renderOffset,
          format,
          durationInFrames: scene.duration,
          renderOffset: scene.renderOffset,
        })),
      );

      expect(audio.type).toBe(Audio);
      expect(audio.props.src).toBe(staticFile(DEMO_ASSETS.audio[format]));
      expect(audio.props.children as ReactNode).toBeUndefined();
    },
  );

  it.each(ASSEMBLY_CASES)(
    "maps global frames to canonical $format scene time",
    ({ scenes }) => {
      for (const scene of scenes) {
        const renderLocalFrame = (globalFrame: number) =>
          globalFrame - scene.renderFrom;

        expect(
          toLogicalSceneFrame(
            renderLocalFrame(scene.canonicalFrom - 1),
            scene.renderOffset,
          ),
        ).toBe(0);
        expect(
          toLogicalSceneFrame(
            renderLocalFrame(scene.canonicalFrom),
            scene.renderOffset,
          ),
        ).toBe(0);
        expect(
          toLogicalSceneFrame(
            renderLocalFrame(scene.canonicalFrom + 1),
            scene.renderOffset,
          ),
        ).toBe(1);
      }
    },
  );
});
