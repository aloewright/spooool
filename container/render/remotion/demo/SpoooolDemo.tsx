import { Audio } from "@remotion/media";
import type { ComponentType } from "react";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { DEMO_ASSETS } from "./demo-assets";
import { getDemoTimeline } from "./demo-timeline";
import type { DemoFormat, DemoSceneKey } from "./demo-timeline";
import { BrandScene } from "./scenes/BrandScene";
import { ComposeScene } from "./scenes/ComposeScene";
import { PublishScene } from "./scenes/PublishScene";
import { RefineScene } from "./scenes/RefineScene";
import { ShapeScene } from "./scenes/ShapeScene";
import { SparkScene } from "./scenes/SparkScene";

export { DEMO_BRAND_NAME, DEMO_COPY, DEMO_SCENE_COPY } from "./demo-copy";

export type SpoooolDemoProps = Readonly<{
  format: DemoFormat;
}>;

type DemoSceneProps = Readonly<{
  format: DemoFormat;
  durationInFrames: number;
}>;

export const DEMO_SCENES: Readonly<
  Record<DemoSceneKey, ComponentType<DemoSceneProps>>
> = {
  spark: SparkScene,
  compose: ComposeScene,
  shape: ShapeScene,
  refine: RefineScene,
  publish: PublishScene,
  brand: BrandScene,
};

export const SpoooolDemo = ({ format }: SpoooolDemoProps) => {
  const timeline = getDemoTimeline(format);

  return (
    <AbsoluteFill>
      {timeline.map((scene) => {
        const Scene = DEMO_SCENES[scene.key];

        return (
          <Sequence
            key={scene.key}
            from={scene.from}
            durationInFrames={scene.duration}
            premountFor={30}
          >
            <Scene format={format} durationInFrames={scene.duration} />
          </Sequence>
        );
      })}
      <Audio src={staticFile(DEMO_ASSETS.audio[format])} />
    </AbsoluteFill>
  );
};
