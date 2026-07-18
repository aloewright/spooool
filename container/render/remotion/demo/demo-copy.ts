export const DEMO_COPY = [
  "An idea.",
  "Start with a spark.",
  "Give it shape.",
  "Make every word count.",
  "Ready when you are.",
  "Where ideas become stories.",
  "spooool.com/studio",
] as const;

export const DEMO_BRAND_NAME = "Spooool";

export const DEMO_SCENE_COPY = {
  spark: DEMO_COPY[0],
  compose: DEMO_COPY[1],
  shape: DEMO_COPY[2],
  refine: DEMO_COPY[3],
  publish: DEMO_COPY[4],
  brand: {
    tagline: DEMO_COPY[5],
    url: DEMO_COPY[6],
  },
} as const;
