import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

type SplashPhase = 'entering' | 'holding' | 'leaving';

export const BRAND_SPLASH_TIMINGS = {
  enter: 480,
  hold: 760,
  leave: 280,
  reducedHold: 140,
  reducedLeave: 100,
  fallbackBuffer: 120,
} as const;

const SPLASH_SEEN_KEY = 'splash:seen';
const letters = ['s', 'p', 'o', 'o', 'o', 'o', 'l'] as const;
type SplashStyle = CSSProperties & {
  '--splash-enter-duration'?: string;
  '--splash-hold-duration'?: string;
  '--splash-leave-duration'?: string;
  '--splash-reduced-hold-duration'?: string;
  '--splash-reduced-leave-duration'?: string;
  '--splash-o-index'?: string;
};

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

function markSplashSeen(): void {
  try {
    window.sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
  } catch {
    // Storage can be unavailable in private browsing or embedded contexts.
  }
}

export function BrandSplash({ onDone }: { onDone: () => void }): JSX.Element {
  const [reducedMotion] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<SplashPhase>(reducedMotion ? 'holding' : 'entering');
  const hasFinished = useRef(false);

  const finish = useCallback(() => {
    if (hasFinished.current) return;
    hasFinished.current = true;
    onDone();
  }, [onDone]);

  const leave = useCallback(() => {
    setPhase((current) => (current === 'leaving' ? current : 'leaving'));
  }, []);

  useEffect(() => {
    const timers: Record<SplashPhase, () => void> = {
      entering: () => setPhase('holding'),
      holding: leave,
      leaving: finish,
    };
    const delays: Record<SplashPhase, number> = {
      entering: BRAND_SPLASH_TIMINGS.enter,
      holding: reducedMotion ? BRAND_SPLASH_TIMINGS.reducedHold : BRAND_SPLASH_TIMINGS.hold,
      leaving: reducedMotion ? BRAND_SPLASH_TIMINGS.reducedLeave : BRAND_SPLASH_TIMINGS.leave,
    };
    const timer = window.setTimeout(timers[phase], delays[phase]);
    return () => window.clearTimeout(timer);
  }, [finish, leave, phase, reducedMotion]);

  useEffect(() => {
    const total = reducedMotion
      ? BRAND_SPLASH_TIMINGS.reducedHold + BRAND_SPLASH_TIMINGS.reducedLeave
      : BRAND_SPLASH_TIMINGS.enter + BRAND_SPLASH_TIMINGS.hold + BRAND_SPLASH_TIMINGS.leave;
    const fallback = window.setTimeout(finish, total + BRAND_SPLASH_TIMINGS.fallbackBuffer);
    return () => window.clearTimeout(fallback);
  }, [finish, reducedMotion]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      event.preventDefault();
      leave();
    }
  };

  const style: SplashStyle = {
    '--splash-enter-duration': `${BRAND_SPLASH_TIMINGS.enter}ms`,
    '--splash-hold-duration': `${BRAND_SPLASH_TIMINGS.hold}ms`,
    '--splash-leave-duration': `${BRAND_SPLASH_TIMINGS.leave}ms`,
    '--splash-reduced-hold-duration': `${BRAND_SPLASH_TIMINGS.reducedHold}ms`,
    '--splash-reduced-leave-duration': `${BRAND_SPLASH_TIMINGS.reducedLeave}ms`,
  };

  return (
    <button
      type="button"
      className="splash"
      aria-label="spooool"
      autoFocus
      data-phase={phase}
      data-reduced-motion={String(reducedMotion)}
      style={style}
      onClick={leave}
      onKeyDown={handleKeyDown}
    >
      {letters.map((letter, index) => {
        const oIndex = index - 2;
        const style: SplashStyle = letter === 'o' ? { '--splash-o-index': String(oIndex) } : {};
        return (
          <span
            className="splash__letter"
            aria-hidden="true"
            style={style}
            key={`${letter}-${index}`}
          >
            {letter}
          </span>
        );
      })}
    </button>
  );
}

export function useBrandSplash(pathname: string): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(() => {
    if (pathname !== '/') return false;
    try {
      if (window.sessionStorage.getItem(SPLASH_SEEN_KEY) === '1') return false;
    } catch {
      // Continue showing the splash if storage cannot be read.
    }
    markSplashSeen();
    return true;
  });

  const dismiss = useCallback(() => {
    markSplashSeen();
    setShow(false);
  }, []);

  return { show: pathname === '/' && show, dismiss };
}
