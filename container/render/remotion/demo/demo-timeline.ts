export const DEMO_FPS = 30;
export const LANDSCAPE_DURATION = 900;
export const VERTICAL_DURATION = 660;

export type DemoFormat = "landscape" | "vertical";
export type DemoSceneKey =
  | "spark"
  | "compose"
  | "shape"
  | "refine"
  | "publish"
  | "brand";
export type DemoScene = Readonly<{
  key: DemoSceneKey;
  from: number;
  duration: number;
}>;

export const LANDSCAPE_SCENES: readonly DemoScene[] = [
  { key: "spark", from: 0, duration: 90 },
  { key: "compose", from: 90, duration: 150 },
  { key: "shape", from: 240, duration: 180 },
  { key: "refine", from: 420, duration: 210 },
  { key: "publish", from: 630, duration: 150 },
  { key: "brand", from: 780, duration: 120 },
] as const;

export const VERTICAL_SCENES: readonly DemoScene[] = [
  { key: "spark", from: 0, duration: 60 },
  { key: "compose", from: 60, duration: 120 },
  { key: "shape", from: 180, duration: 150 },
  { key: "refine", from: 330, duration: 150 },
  { key: "publish", from: 480, duration: 90 },
  { key: "brand", from: 570, duration: 90 },
] as const;

export const getDemoTimeline = (format: DemoFormat): readonly DemoScene[] =>
  format === "landscape" ? LANDSCAPE_SCENES : VERTICAL_SCENES;

export const validateDemoTimeline = (
  scenes: readonly DemoScene[],
  expectedDuration: number,
): string[] => {
  const errors: string[] = [];

  scenes.forEach((scene, index) => {
    const previous = scenes[index - 1];
    const expectedFrom = previous ? previous.from + previous.duration : 0;

    if (scene.from !== expectedFrom) {
      errors.push(
        scene.key + " starts at " + scene.from + ", expected " + expectedFrom,
      );
    }
    if (scene.duration <= 0) {
      errors.push(scene.key + " must have a positive duration");
    }
  });

  const last = scenes.at(-1);
  const end = last ? last.from + last.duration : 0;

  if (end !== expectedDuration) {
    errors.push("timeline ends at " + end + ", expected " + expectedDuration);
  }

  return errors;
};
