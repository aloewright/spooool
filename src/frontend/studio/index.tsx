import { AnimationPanel } from './AnimationPanel';
import { AIStudio } from './AIStudio';
import { ImagePanel } from './ImagePanel';

import type { JSX } from "react";

export function StudioRoot({ videoId }: { videoId?: string } = {}): JSX.Element {
  return (
    <div className="stack stack-xl">
      <section className="stack stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Animated video</h2>
        <AnimationPanel />
      </section>
      <section className="stack stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Chat</h2>
        <AIStudio />
      </section>
      <section className="stack stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Image generation</h2>
        <ImagePanel videoId={videoId} />
      </section>
    </div>
  );
}
