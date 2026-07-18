import { Audio } from "@remotion/media";
import type { ComponentType } from "react";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { DemoSceneTransition } from "./components/DemoSceneTransition";
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
  renderOffset: number;
}>;

const DEMO_TRANSITION_FRAMES = 15;

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
      {timeline.map((scene, index) => {
        const Scene = DEMO_SCENES[scene.key];
        const transitionInFrames = index === 0 ? 0 : DEMO_TRANSITION_FRAMES;
        const renderFrom = scene.from - transitionInFrames;
        const renderDuration = scene.duration + transitionInFrames;

        return (
          <Sequence
            key={scene.key}
            from={renderFrom}
            durationInFrames={renderDuration}
            premountFor={30}
          >
            <DemoSceneTransition transitionInFrames={transitionInFrames}>
              <Scene
                format={format}
                durationInFrames={scene.duration}
                renderOffset={transitionInFrames}
              />
            </DemoSceneTransition>
          </Sequence>
        );
      })}
      <Audio src={staticFile(DEMO_ASSETS.audio[format])} />
    </AbsoluteFill>
  );
};
