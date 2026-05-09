// ALO-141: Strand-themed custom video controls. Renders an overlay on top of
// the native <video> element, replacing the default UA controls bar so the
// player matches the rest of the Strand design system. The keyboard shortcut
// layer (j/k/l, space, ←/→, f, m, 0–9) lives on the Watch page and is shared
// between this overlay and headless callers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativePlayer } from '../lib/native-player';

const HIDE_AFTER_MS = 2500;

export function formatHms(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface Props {
  /** The adapter wrapping the underlying <video>. Null while the source loads. */
  player: NativePlayer | null;
}

interface PlayerState {
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  buffered: number;
  isFullscreen: boolean;
  waiting: boolean;
}

const INITIAL_STATE: PlayerState = {
  paused: true,
  muted: false,
  volume: 1,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  isFullscreen: false,
  waiting: false,
};

export function PlayerControls({ player }: Props): JSX.Element | null {
  const [state, setState] = useState<PlayerState>(INITIAL_STATE);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  // Visibility is driven by an inactivity timer + hover/focus state. We start
  // visible so the user always sees the bar on first paint.
  const [active, setActive] = useState(true);
  const hideTimer = useRef<number | null>(null);

  // Pull a snapshot of player state into React. Cheap because the adapter's
  // getters are direct property reads on the <video> element.
  const sync = useCallback((): void => {
    if (!player) return;
    setState({
      paused: player.paused(),
      muted: player.muted(),
      volume: player.volume(),
      currentTime: player.currentTime(),
      duration: player.duration(),
      buffered: player.bufferedAhead(),
      isFullscreen: player.isFullscreen(),
      // Don't reset waiting on a generic sync — flip false only on `playing`.
      waiting: false,
    });
  }, [player]);

  useEffect(() => {
    if (!player) return;
    const onTimeupdate = (): void => {
      setState((s) => ({
        ...s,
        currentTime: player.currentTime(),
        buffered: player.bufferedAhead(),
      }));
    };
    const onDuration = (): void => {
      setState((s) => ({ ...s, duration: player.duration() }));
    };
    const onPlay = (): void => setState((s) => ({ ...s, paused: false }));
    const onPause = (): void => setState((s) => ({ ...s, paused: true, waiting: false }));
    const onPlaying = (): void => setState((s) => ({ ...s, paused: false, waiting: false }));
    const onWaiting = (): void => setState((s) => ({ ...s, waiting: true }));
    const onVolume = (): void =>
      setState((s) => ({ ...s, muted: player.muted(), volume: player.volume() }));
    const onProgress = (): void =>
      setState((s) => ({ ...s, buffered: player.bufferedAhead() }));

    sync();
    player.on('loadedmetadata', sync);
    player.on('durationchange', onDuration);
    player.on('timeupdate', onTimeupdate);
    player.on('play', onPlay);
    player.on('pause', onPause);
    player.on('playing', onPlaying);
    player.on('waiting', onWaiting);
    player.on('volumechange', onVolume);
    player.on('progress', onProgress);

    return () => {
      player.off('loadedmetadata', sync);
      player.off('durationchange', onDuration);
      player.off('timeupdate', onTimeupdate);
      player.off('play', onPlay);
      player.off('pause', onPause);
      player.off('playing', onPlaying);
      player.off('waiting', onWaiting);
      player.off('volumechange', onVolume);
      player.off('progress', onProgress);
    };
  }, [player, sync]);

  // Reflect fullscreen changes triggered from outside the component (e.g. the
  // `f` keyboard shortcut, or the OS fullscreen widget).
  useEffect(() => {
    const onFsChange = (): void => {
      if (!player) return;
      setState((s) => ({ ...s, isFullscreen: player.isFullscreen() }));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [player]);

  const ping = useCallback((): void => {
    setActive(true);
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
    }
    hideTimer.current = window.setTimeout(() => {
      setActive(false);
    }, HIDE_AFTER_MS);
  }, []);

  // Always show controls when paused (matches every video player on earth).
  // Once playback starts, the inactivity timer takes over.
  useEffect(() => {
    if (state.paused || scrubbing) {
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
      setActive(true);
      return;
    }
    ping();
    return () => {
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [state.paused, scrubbing, ping]);

  const togglePlay = useCallback((): void => {
    if (!player) return;
    if (player.paused()) {
      void player.play();
    } else {
      player.pause();
    }
  }, [player]);

  const toggleMute = useCallback((): void => {
    if (!player) return;
    player.setMuted(!player.muted());
  }, [player]);

  const toggleFullscreen = useCallback((): void => {
    if (!player) return;
    if (player.isFullscreen()) {
      void player.exitFullscreen();
    } else {
      void player.requestFullscreen();
    }
  }, [player]);

  const onScrubChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const v = Number(e.target.value);
      setScrubValue(v);
      // Live-update the playhead while scrubbing so the user sees the frame
      // under their thumb. Doesn't fire timeupdate while paused on some
      // browsers, hence the manual setState above.
      player?.setCurrentTime(v);
    },
    [player],
  );

  const onScrubStart = useCallback((): void => {
    setScrubbing(true);
  }, []);

  const onScrubEnd = useCallback((): void => {
    setScrubbing(false);
    setScrubValue(null);
  }, []);

  const onVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      if (!player) return;
      const v = Number(e.target.value);
      player.setVolume(v);
    },
    [player],
  );

  const displayedTime = scrubValue ?? state.currentTime;
  const sliderMax = state.duration > 0 ? state.duration : 0;
  const volumePercent = state.muted ? 0 : Math.round(state.volume * 100);

  // Inline progress fill so we don't need separate per-track CSS for buffered
  // / played percentages — both ride on top of the same range input.
  const playedPct = useMemo(() => {
    if (sliderMax <= 0) return 0;
    return Math.min(100, Math.max(0, (displayedTime / sliderMax) * 100));
  }, [displayedTime, sliderMax]);

  const bufferedPct = useMemo(() => {
    if (sliderMax <= 0) return 0;
    return Math.min(100, Math.max(0, (state.buffered / sliderMax) * 100));
  }, [state.buffered, sliderMax]);

  if (!player) return null;

  // Show full HH:MM:SS once the duration crosses an hour, mm:ss otherwise.
  const timeLabel = `${formatHms(displayedTime)} / ${formatHms(state.duration)}`;

  return (
    <div
      className={`player__controls${active ? '' : ' player__controls--idle'}`}
      onMouseMove={ping}
      onMouseEnter={ping}
      onMouseLeave={() => {
        if (!state.paused && !scrubbing) setActive(false);
      }}
      onFocus={ping}
    >
      <div className="player__center" aria-hidden={!state.paused && !state.waiting}>
        {state.paused ? (
          <button
            type="button"
            className="player__bigplay"
            onClick={togglePlay}
            aria-label="Play video"
          >
            <PlayGlyph />
          </button>
        ) : state.waiting ? (
          <div className="player__spinner" role="status" aria-label="Buffering" />
        ) : null}
      </div>

      <div className="player__bar">
        <div className="player__scrubber-wrap">
          <div
            className="player__scrubber-track"
            aria-hidden="true"
            style={{ ['--player-buffered' as string]: `${bufferedPct}%`, ['--player-played' as string]: `${playedPct}%` }}
          >
            <div className="player__scrubber-buffered" />
            <div className="player__scrubber-played" />
          </div>
          <input
            className="player__scrubber"
            type="range"
            min={0}
            max={sliderMax || 1}
            step={0.1}
            value={Math.min(displayedTime, sliderMax || 0)}
            onChange={onScrubChange}
            onMouseDown={onScrubStart}
            onMouseUp={onScrubEnd}
            onTouchStart={onScrubStart}
            onTouchEnd={onScrubEnd}
            onPointerDown={onScrubStart}
            onPointerUp={onScrubEnd}
            disabled={sliderMax <= 0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={sliderMax || 0}
            aria-valuenow={displayedTime}
            aria-valuetext={formatHms(displayedTime)}
          />
        </div>

        <div className="player__row">
          <button
            type="button"
            className="player__btn"
            onClick={togglePlay}
            aria-label={state.paused ? 'Play' : 'Pause'}
            aria-pressed={!state.paused}
          >
            {state.paused ? <PlayGlyph /> : <PauseGlyph />}
          </button>

          <div className="player__volume">
            <button
              type="button"
              className="player__btn"
              onClick={toggleMute}
              aria-label={state.muted ? 'Unmute' : 'Mute'}
              aria-pressed={state.muted}
            >
              {state.muted || state.volume === 0 ? <MutedGlyph /> : <VolumeGlyph />}
            </button>
            <input
              className="player__volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.muted ? 0 : state.volume}
              onChange={onVolumeChange}
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={volumePercent}
              aria-valuetext={`${volumePercent}%`}
            />
          </div>

          <div className="player__time" aria-live="off">
            {timeLabel}
          </div>

          <div className="player__spacer" />

          <button
            type="button"
            className="player__btn"
            onClick={toggleFullscreen}
            aria-label={state.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={state.isFullscreen}
          >
            {state.isFullscreen ? <FullscreenExitGlyph /> : <FullscreenGlyph />}
          </button>
        </div>
      </div>
    </div>
  );
}

const glyph = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'currentColor',
  'aria-hidden': true,
  focusable: false,
};

function PlayGlyph(): JSX.Element {
  return (
    <svg {...glyph}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseGlyph(): JSX.Element {
  return (
    <svg {...glyph}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function VolumeGlyph(): JSX.Element {
  return (
    <svg {...glyph}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16 8.5a4 4 0 0 1 0 7" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function MutedGlyph(): JSX.Element {
  return (
    <svg {...glyph}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function FullscreenGlyph(): JSX.Element {
  return (
    <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  );
}

function FullscreenExitGlyph(): JSX.Element {
  return (
    <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4v5H4" />
      <path d="M15 4v5h5" />
      <path d="M9 20v-5H4" />
      <path d="M15 20v-5h5" />
    </svg>
  );
}
