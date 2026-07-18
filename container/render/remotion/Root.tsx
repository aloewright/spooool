import { Composition } from "remotion";
import { videoConf } from "../config/scenes";
import { GoToRecorder } from "./GoToRecorder";
import { Main } from "./Main";
import { calcMetadata } from "./calculate-metadata/calc-metadata";
import { SpoooolVideo, FRAMES_PER_TAKE } from "./SpoooolVideo";
import type { SpoooolVideoProps } from "./SpoooolVideo";
import { SpoooolExplainer, calculateExplainerDuration } from "./SpoooolExplainer";
import { SpoooolAnimation, DEFAULT_ANIMATION_PROJECT, calculateAnimationMetadata } from "./SpoooolAnimation";
import { SpoooolDemo } from "./demo/SpoooolDemo";
import {
  DEMO_FPS,
  LANDSCAPE_DURATION,
  VERTICAL_DURATION,
} from "./demo/demo-timeline";

const SPOOOOL_DEFAULT_PROPS: SpoooolVideoProps = {
  takes: [] as string[],
  title: "Spooool recording",
  brand: { color: "#0a84ff" },
  sceneOrder: ["intro", "main", "outro"] as string[],
  layouts: {} as Record<string, unknown>,
};

export const RemotionRoot = () => {
  return (
    <>
      {/* spooool-video — primary composition used by the headless render harness */}
      <Composition
        component={SpoooolVideo}
        id="spooool-video"
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={1}
        defaultProps={SPOOOOL_DEFAULT_PROPS}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(1, props.takes.length) * FRAMES_PER_TAKE,
        })}
      />
      {/* spooool-animation — AI Studio prompt-generated animation composition */}
      <Composition
        id="spooool-animation"
        component={SpoooolAnimation}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={DEFAULT_ANIMATION_PROJECT.durationFrames}
        defaultProps={{
          compositionId: 'spooool-animation',
          animation: DEFAULT_ANIMATION_PROJECT,
          assets: [],
          brand: { color: '#0a84ff' },
        }}
        calculateMetadata={({ props }) => calculateAnimationMetadata(props)}
      />
      {/* spooool-explainer — prompt-to-video composition driven by ComposerAgent */}
      <Composition
        id="spooool-explainer"
        component={SpoooolExplainer}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={1}
        defaultProps={{
          scenes: [],
          audio: { r2Path: "" },
          brand: { color: "#0a84ff" },
        }}
        calculateMetadata={({ props }) => ({
          durationInFrames: calculateExplainerDuration(props.scenes ?? []),
        })}
      />
      {/* spooool-demo — fixed landscape and vertical product-film compositions */}
      <Composition
        id="spooool-demo-landscape"
        component={SpoooolDemo}
        width={1920}
        height={1080}
        fps={DEMO_FPS}
        durationInFrames={LANDSCAPE_DURATION}
        defaultProps={{ format: "landscape" as const }}
      />
      <Composition
        id="spooool-demo-vertical"
        component={SpoooolDemo}
        width={1080}
        height={1920}
        fps={DEMO_FPS}
        durationInFrames={VERTICAL_DURATION}
        defaultProps={{ format: "vertical" as const }}
      />
      {/* Upstream recorder compositions — kept intact for reference / future use */}
      <Composition
        component={Main}
        id="welcome"
        schema={videoConf}
        defaultProps={{
          theme: "light" as const,
          canvasLayout: "square" as const,
          scenes: [
            {
              type: "recorder" as const,
              durationInFrames: 80,
              music: "epic" as const,
              transitionToNextScene: true,
            },
            {
              type: "videoscene" as const,
              webcamPosition: "previous" as const,
              endOffset: 0,
              transitionToNextScene: true,
              newChapter: "",
              stopChapteringAfterThis: false,
              music: "previous" as const,
              startOffset: 0,
              bRolls: [],
            },
            {
              type: "videoscene" as const,
              webcamPosition: "previous" as const,
              endOffset: 0,
              transitionToNextScene: true,
              newChapter: "",
              stopChapteringAfterThis: false,
              music: "previous" as const,
              startOffset: 0,
              bRolls: [],
            },
            {
              type: "videoscene" as const,
              webcamPosition: "previous" as const,
              endOffset: 0,
              transitionToNextScene: true,
              newChapter: "",
              stopChapteringAfterThis: false,
              music: "previous" as const,
              startOffset: 0,
              bRolls: [],
            },
            {
              type: "videoscene" as const,
              webcamPosition: "previous" as const,
              endOffset: 0,
              transitionToNextScene: true,
              newChapter: "",
              stopChapteringAfterThis: false,
              music: "previous" as const,
              startOffset: 0,
              bRolls: [],
            },
            {
              music: "previous" as const,
              transitionToNextScene: true,
              type: "endcard" as const,
              durationInFrames: 200,
              channel: "remotion" as const,
              links: [
                { link: "remotion.dev/recorder" },
                { link: "remotion.dev/discord" },
              ],
            },
          ],
          scenesAndMetadata: [],
          platform: "x" as const,
        }}
        calculateMetadata={calcMetadata}
      />
      <Composition
        component={GoToRecorder}
        id="record"
        width={1080}
        height={1080}
        fps={30}
        durationInFrames={100}
      />
      <Composition
        component={Main}
        id="empty"
        schema={videoConf}
        defaultProps={{
          theme: "light" as const,
          canvasLayout: "square" as const,
          platform: "youtube",
          scenes: [],
          scenesAndMetadata: [],
        }}
        calculateMetadata={calcMetadata}
      />
    </>
  );
};
