import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';

export interface ExplainerScene {
  type: 'title' | 'beat' | 'outro';
  durationFrames: number;
  text: string;
  subtitle?: string;
}

export interface ExplainerProps {
  scenes: ExplainerScene[];
  /**
   * Audio overlay. Optional — when undefined or `r2Path` is empty, the
   * composition renders silent (TTS failure shouldn't block the video,
   * the user still gets the visuals).
   */
  audio?: { r2Path?: string };
  brand?: { color?: string };
}

export function calculateExplainerDuration(scenes: ExplainerScene[]): number {
  if (scenes.length === 0) return 1;
  return scenes.reduce((sum, s) => sum + Math.max(1, s.durationFrames), 0);
}

const sceneStyle = (background: string): React.CSSProperties => ({
  backgroundColor: background,
  color: 'white',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  padding: 80,
  fontFamily: 'Inter, system-ui, sans-serif',
});

const titleText: React.CSSProperties = { fontSize: 96, fontWeight: 700, textAlign: 'center', maxWidth: 1600 };
const beatText: React.CSSProperties = { fontSize: 72, fontWeight: 500, textAlign: 'center', maxWidth: 1600, lineHeight: 1.2 };
const outroText: React.CSSProperties = { fontSize: 84, fontWeight: 600, textAlign: 'center', maxWidth: 1600 };
const subtitleText: React.CSSProperties = { fontSize: 40, fontWeight: 400, marginTop: 32, opacity: 0.85, maxWidth: 1400, textAlign: 'center' };

export const SpoooolExplainer: React.FC<ExplainerProps> = ({ scenes, audio, brand }) => {
  const background = brand?.color ?? '#0a84ff';
  let startFrame = 0;
  const audioPath = audio?.r2Path;
  return (
    <AbsoluteFill>
      {audioPath ? <Audio src={staticFile(audioPath)} /> : null}
      {scenes.map((scene, i) => {
        const seq = (
          <Sequence key={i} from={startFrame} durationInFrames={Math.max(1, scene.durationFrames)}>
            <AbsoluteFill style={sceneStyle(background)}>
              <div style={scene.type === 'title' ? titleText : scene.type === 'outro' ? outroText : beatText}>
                {scene.text}
              </div>
              {scene.subtitle ? <div style={subtitleText}>{scene.subtitle}</div> : null}
            </AbsoluteFill>
          </Sequence>
        );
        startFrame += Math.max(1, scene.durationFrames);
        return seq;
      })}
    </AbsoluteFill>
  );
};
