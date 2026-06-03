import { AIStudio } from './AIStudio';
import { ImagePanel } from './ImagePanel';

export function StudioRoot({ videoId }: { videoId?: string } = {}): JSX.Element {
  return (
    <div className="stack-lg">
      <section className="stack-sm">
        <h2 className="ds-h3">Chat</h2>
        <AIStudio />
      </section>
      <section className="stack-sm">
        <h2 className="ds-h3">Image generation</h2>
        <ImagePanel videoId={videoId} />
      </section>
    </div>
  );
}
