import * as React from 'react';
import Lottie, { type LottieRefCurrentProps } from 'lottie-react';

const FAST_REPEATS = 4;
const SLOW_REPEATS = 2;

const spiralFastData = {"nm":"spiral2","h":16,"w":16,"meta":{"g":"@lottiefiles/toolkit-js 0.71.7"},"layers":[{"ty":4,"nm":"Vector 5821 copy Outlines","sr":1,"st":0,"op":30,"ip":0,"ln":"18","hasMask":false,"ao":0,"ks":{"a":{"a":0,"k":[12.5,6.5,0]},"s":{"a":0,"k":[100,100,100]},"p":{"a":1,"k":[{"o":{"x":0.167,"y":0.167},"i":{"x":0.833,"y":0.833},"s":[12,8,0],"t":0},{"s":[4,8,0],"t":29}]},"r":{"a":0,"k":0},"sa":{"a":0,"k":0},"o":{"a":0,"k":24}},"shapes":[{"ty":"gr","nm":"Group 1","it":[{"ty":"sh","nm":"Path 1","d":1,"ks":{"a":0,"k":{"c":false,"i":[[0,0],[-0.289,3.296],[2.218,0],[-0.23,-2.627],[-4.452,0],[-0.289,3.296],[2.218,0],[-0.23,-2.627],[-4.452,0],[-0.289,3.296],[2.218,0],[-0.232,-2.627],[-4.443,0]],"o":[[4.452,0],[0.23,-2.627],[-2.218,0],[0.289,3.296],[4.452,0],[0.23,-2.627],[-2.218,0],[0.289,3.296],[4.452,0],[0.23,-2.627],[-2.218,0],[0.292,3.296],[0,0]],"v":[[-12,6],[-4.975,-1.012],[-8,-6],[-11.025,-1.012],[-4,6],[3.025,-1.012],[0,-6],[-3.025,-1.012],[4,6],[11.025,-1.012],[8,-6],[4.98,-1.012],[12,6]]}}},{"ty":"st","nm":"Stroke 1","lc":2,"lj":2,"ml":4,"o":{"a":0,"k":100},"w":{"a":0,"k":1.4},"c":{"a":0,"k":[1,1,1]}},{"ty":"tr","a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"p":{"a":0,"k":[12.5,6.5]},"r":{"a":0,"k":0},"sa":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"tm","nm":"Trim Paths 1","e":{"a":1,"k":[{"o":{"x":0.341,"y":0.488},"i":{"x":0.269,"y":0.75},"s":[44],"t":0},{"s":[77],"t":29}]},"o":{"a":0,"k":0},"s":{"a":1,"k":[{"o":{"x":0.32,"y":0.154},"i":{"x":0.826,"y":0.579},"s":[23],"t":0},{"s":[57],"t":29}]},"m":1}],"ind":1}],"v":"5.7.0","fr":60,"op":30,"ip":0,"assets":[]};

const spiralSlowData = {"nm":"spiral1","h":16,"w":16,"meta":{"g":"@lottiefiles/toolkit-js 0.71.7"},"layers":[{"ty":4,"nm":"Vector 5821 copy Outlines","sr":1,"st":0,"op":60,"ip":0,"ln":"18","hasMask":false,"ao":0,"ks":{"a":{"a":0,"k":[12.5,6.5,0]},"s":{"a":0,"k":[100,100,100]},"p":{"a":1,"k":[{"o":{"x":0.167,"y":0.167},"i":{"x":0.833,"y":0.833},"s":[12,8,0],"t":0},{"s":[4,8,0],"t":59}]},"r":{"a":0,"k":0},"sa":{"a":0,"k":0},"o":{"a":0,"k":24}},"shapes":[{"ty":"gr","nm":"Group 1","it":[{"ty":"sh","nm":"Path 1","d":1,"ks":{"a":0,"k":{"c":false,"i":[[0,0],[-0.289,3.296],[2.218,0],[-0.23,-2.627],[-4.452,0],[-0.289,3.296],[2.218,0],[-0.23,-2.627],[-4.452,0],[-0.289,3.296],[2.218,0],[-0.232,-2.627],[-4.443,0]],"o":[[4.452,0],[0.23,-2.627],[-2.218,0],[0.289,3.296],[4.452,0],[0.23,-2.627],[-2.218,0],[0.289,3.296],[4.452,0],[0.23,-2.627],[-2.218,0],[0.292,3.296],[0,0]],"v":[[-12,6],[-4.975,-1.012],[-8,-6],[-11.025,-1.012],[-4,6],[3.025,-1.012],[0,-6],[-3.025,-1.012],[4,6],[11.025,-1.012],[8,-6],[4.98,-1.012],[12,6]]}}},{"ty":"st","nm":"Stroke 1","lc":2,"lj":2,"ml":4,"o":{"a":0,"k":100},"w":{"a":0,"k":1.4},"c":{"a":0,"k":[1,1,1]}},{"ty":"tr","a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"p":{"a":0,"k":[12.5,6.5]},"r":{"a":0,"k":0},"sa":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"tm","nm":"Trim Paths 1","e":{"a":1,"k":[{"o":{"x":0.341,"y":0.992},"i":{"x":0.269,"y":0.491},"s":[44],"t":0},{"s":[77],"t":59}]},"o":{"a":0,"k":0},"s":{"a":1,"k":[{"o":{"x":0.32,"y":0.313},"i":{"x":0.826,"y":0.143},"s":[23],"t":0},{"s":[57],"t":59}]},"m":1}],"ind":1}],"v":"5.7.0","fr":60,"op":60,"ip":0,"assets":[]};

function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = React.useState(false);
  React.useEffect(() => {
    const update = (): void => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export type SpiralLoaderProps = {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
};

// The lottie strokes ship as white. In dark mode they're already correct;
// in light mode we invert via a CSS filter so they become black.
export function SpiralLoader({ size = 16, className, style }: SpiralLoaderProps): JSX.Element | null {
  const [isMounted, setIsMounted] = React.useState(false);
  const [phase, setPhase] = React.useState<'fast' | 'slow'>('fast');
  const repeatCountRef = React.useRef(0);
  const fastRef = React.useRef<LottieRefCurrentProps | null>(null);
  const slowRef = React.useRef<LottieRefCurrentProps | null>(null);
  const isDark = useIsDarkTheme();

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  const startFastPhase = React.useCallback(() => {
    repeatCountRef.current = 0;
    setPhase('fast');
    slowRef.current?.stop();
    fastRef.current?.goToAndPlay(0, true);
  }, []);

  const startSlowPhase = React.useCallback(() => {
    repeatCountRef.current = 0;
    setPhase('slow');
    fastRef.current?.stop();
    slowRef.current?.goToAndPlay(0, true);
  }, []);

  const handleFastComplete = React.useCallback(() => {
    repeatCountRef.current += 1;
    if (repeatCountRef.current < FAST_REPEATS) {
      fastRef.current?.goToAndPlay(0, true);
    } else {
      startSlowPhase();
    }
  }, [startSlowPhase]);

  const handleSlowComplete = React.useCallback(() => {
    repeatCountRef.current += 1;
    if (repeatCountRef.current < SLOW_REPEATS) {
      slowRef.current?.goToAndPlay(0, true);
    } else {
      startFastPhase();
    }
  }, [startFastPhase]);

  if (!isMounted) return null;
  const filter = !isDark ? 'invert(1)' : undefined;

  const layer: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    transition: 'opacity 75ms linear',
    filter,
  };

  return (
    <div
      className={className}
      style={{ position: 'relative', flexShrink: 0, width: size, height: size, ...style }}
    >
      <div style={{ ...layer, opacity: phase === 'fast' ? 1 : 0 }}>
        <Lottie
          lottieRef={fastRef}
          animationData={spiralFastData}
          loop={false}
          autoplay
          onComplete={handleFastComplete}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
      <div style={{ ...layer, opacity: phase === 'slow' ? 1 : 0 }}>
        <Lottie
          lottieRef={slowRef}
          animationData={spiralSlowData}
          loop={false}
          autoplay={false}
          onComplete={handleSlowComplete}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
