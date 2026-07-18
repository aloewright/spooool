export const DEMO_ASSETS = {
  screens: {
    home: "demo/screens/studio-home.png",
    compose: "demo/screens/studio-compose.png",
    outline: "demo/screens/studio-outline.png",
    editor: "demo/screens/studio-editor.png",
    book: "demo/screens/studio-book.png",
    publish: "demo/screens/studio-publish.png",
  },
  audio: {
    landscape: "demo/audio/spooool-demo-landscape.wav",
    vertical: "demo/audio/spooool-demo-vertical.wav",
  },
} as const;

export const getRequiredDemoAssets = (): string[] => [
  ...Object.values(DEMO_ASSETS.screens),
  ...Object.values(DEMO_ASSETS.audio),
];
