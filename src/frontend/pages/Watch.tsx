import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
// ALO-283: keep Comments (459 LoC) + ReportButton + VideoTags out of the
// initial Watch chunk. They render below the player (and Comments is below
// the fold for most viewports), so the network cost only fires once the
// player has had a chance to start streaming.
const Comments = lazy(() =>
  import('../components/Comments').then((m) => ({ default: m.Comments })),
);
const ReportButton = lazy(() =>
  import('../components/ReportButton').then((m) => ({ default: m.ReportButton })),
);
const VideoTags = lazy(() =>
  import('../components/VideoTags').then((m) => ({ default: m.VideoTags })),
);
import { loadAutoAdvance, saveAutoAdvance } from '../lib/auto-advance';
import { createNativePlayer, type NativePlayer } from '../lib/native-player';
import { keyToPlayerAction } from '../lib/player-keys';
import {
  clearStoredPosition,
  formatTimeParam,
  loadStoredPosition,
  parseTimeParam,
  saveStoredPosition,
  shouldResumeAt,
} from '../lib/watch-position';

// Persist tick frequency. Pause/visibility/pagehide also force a save.
const POSITION_SAVE_INTERVAL_MS = 5000;

function formatHms(total: number): string {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type VideoResponse = {
  id: string;
  title: string;
  description: string;
  view_count: number;
  channel_name?: string;
  channel_username?: string | null;
  stream_video_id?: string;
  r2_key?: string;
  status?: string;
};

type PlaybackSource = { src: string; type: string } | null;

type UpNextVideo = {
  id: string;
  title: string;
  thumbnail_url?: string | null;
  channel_name?: string | null;
  view_count: number;
};

export function Watch(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [upNext, setUpNext] = useState<UpNextVideo[]>([]);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(false);
  // Latest values held in refs so the player 'ended' handler — registered
  // once per id — can read them without re-binding on every state tick.
  const upNextRef = useRef<UpNextVideo[]>([]);
  const autoAdvanceRef = useRef<boolean>(false);
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [likes, setLikes] = useState<{ count: number; liked: boolean } | null>(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [likeError, setLikeError] = useState<string | null>(null);
  const [sub, setSub] = useState<{ subscribed: boolean; subscriberCount: number } | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // ALO-213: surface stored resume position so the viewer can override it.
  // null = nothing to resume; number = seconds we'd resume at.
  const [resumeOffer, setResumeOffer] = useState<number | null>(null);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<NativePlayer | null>(null);

  // ALO-147: ?t= deep link wins over a stored resume position.
  const startAt = useMemo(
    () => parseTimeParam(searchParams.get('t')),
    [searchParams],
  );
  // ALO-213: explicit "Watch from start" forces a fresh play even if storage
  // has a saved position. Persists for the lifetime of this Watch mount.
  const watchFromStart = searchParams.get('start') === '1';

  const playbackSource: PlaybackSource = useMemo(() => {
    if (!video) return null;
    // Use Stream HLS only when transcoding is finished — until then the
    // manifest 404s. R2 fallback covers the in-between canonical states
    // (uploading, queued, encoding) and the case where Stream isn't
    // configured at all.
    if (video.stream_video_id && video.status === 'ready') {
      return {
        src: `https://videodelivery.net/${video.stream_video_id}/manifest/video.m3u8`,
        type: 'application/x-mpegURL',
      };
    }
    if (video.r2_key) {
      // Direct R2 playback. Only browser-playable formats (MP4/H.264, WebM)
      // will work here; other containers need Stream to transcode first.
      return { src: `/api/videos/${encodeURIComponent(video.id)}/stream`, type: 'video/mp4' };
    }
    return null;
  }, [video]);

  useEffect(() => {
    if (!id) {
      setError('Missing video ID');
      return;
    }
    void fetch(`/api/videos/${id}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load video');
        }
        return (await response.json()) as VideoResponse;
      })
      .then((data) => {
        setVideo(data);
        // ALO-184: emit one event per Watch mount for funnel analysis.
        // We use the public video id (not D1 row id) since that's already in
        // the URL. No PII. Catches a chunk-load failure so the watch path
        // never raises an unhandled promise rejection on telemetry alone.
        void import('../lib/analytics')
          .then(({ track }) =>
            track('video_view', { video_id: data.id, channel: data.channel_username ?? null }),
          )
          .catch(() => undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Unknown error'));
  }, [id]);

  // ALO-145: record this watch in the signed-in user's history. Fire-and-forget;
  // failures are silent so a hiccup against /api/users/me/history can't disrupt
  // playback. Anonymous users are skipped — there's no row to UPSERT for them.
  useEffect(() => {
    if (!id || !session?.user) return;
    void fetch('/api/users/me/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: id }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  }, [id, session?.user]);

  // ALO-152/153: load the up-next list from the related-videos endpoint
  // (same-channel + title FTS + trending top-up). The endpoint already
  // excludes the source id, so no client-side filter is needed; cap to 8
  // to keep the sidebar tight.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void fetch(`/api/videos/${encodeURIComponent(id)}/related?limit=12`)
      .then(async (r) => {
        if (!r.ok) throw new Error('failed');
        return (await r.json()) as { videos: UpNextVideo[] };
      })
      .then((data) => {
        if (cancelled) return;
        const next = data.videos.slice(0, 8);
        setUpNext(next);
        upNextRef.current = next;
      })
      .catch(() => {
        if (!cancelled) {
          setUpNext([]);
          upNextRef.current = [];
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Hydrate the auto-advance toggle from localStorage once on mount and keep
  // a ref in sync for the 'ended' handler.
  useEffect(() => {
    const v = loadAutoAdvance();
    setAutoAdvance(v);
    autoAdvanceRef.current = v;
  }, []);

  const toggleAutoAdvance = useCallback((): void => {
    setAutoAdvance((prev) => {
      const next = !prev;
      autoAdvanceRef.current = next;
      saveAutoAdvance(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void fetch(`/api/videos/${encodeURIComponent(id)}/like`, { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load likes');
        return (await r.json()) as { likes: number; liked: boolean };
      })
      .then((data) => {
        if (!cancelled) setLikes({ count: data.likes, liked: data.liked });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const channelUsername = video?.channel_username ?? null;

  useEffect(() => {
    if (!channelUsername) return;
    let cancelled = false;
    void fetch(
      `/api/channels/${encodeURIComponent(channelUsername)}/subscription`,
      { credentials: 'same-origin' },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load subscription');
        return (await r.json()) as { subscribed: boolean; subscriberCount: number };
      })
      .then((data) => {
        if (!cancelled) setSub(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [channelUsername]);

  const toggleSubscribe = useCallback(async (): Promise<void> => {
    if (!channelUsername || subBusy) return;
    if (!session) {
      setSubError('Sign in to subscribe.');
      return;
    }
    const wasSubscribed = sub?.subscribed ?? false;
    setSubBusy(true);
    setSubError(null);
    try {
      const r = await fetch(
        `/api/channels/${encodeURIComponent(channelUsername)}/subscribe`,
        { method: wasSubscribed ? 'DELETE' : 'POST', credentials: 'same-origin' },
      );
      if (!r.ok) throw new Error('Failed to update subscription');
      setSub((s) => ({
        subscribed: !wasSubscribed,
        subscriberCount: Math.max(0, (s?.subscriberCount ?? 0) + (wasSubscribed ? -1 : 1)),
      }));
      void import('../lib/analytics')
        .then(({ track }) =>
          track('subscribe_toggled', {
            channel: channelUsername,
            subscribed: !wasSubscribed,
          }),
        )
        .catch(() => undefined);
    } catch (err: unknown) {
      setSubError(err instanceof Error ? err.message : 'Failed to update subscription');
    } finally {
      setSubBusy(false);
    }
  }, [channelUsername, session, sub?.subscribed, subBusy]);

  const toggleLike = useCallback(async (): Promise<void> => {
    if (!id || likeBusy) return;
    if (!session) {
      setLikeError('Sign in to like videos.');
      return;
    }
    setLikeBusy(true);
    setLikeError(null);
    try {
      const r = await fetch(`/api/videos/${encodeURIComponent(id)}/like`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error('Failed to update like');
      const data = (await r.json()) as { likes: number; liked: boolean };
      setLikes({ count: data.likes, liked: data.liked });
      void import('../lib/analytics')
        .then(({ track }) => track('video_like_toggled', { video_id: id, liked: data.liked }))
        .catch(() => undefined);
    } catch (err: unknown) {
      setLikeError(err instanceof Error ? err.message : 'Failed to update like');
    } finally {
      setLikeBusy(false);
    }
  }, [id, likeBusy, session]);

  useEffect(() => {
    const el = videoEl.current;
    if (!el || !playbackSource) {
      return;
    }

    playerRef.current?.dispose();
    el.controls = true;
    playerRef.current = createNativePlayer(el, playbackSource);

    return () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, [playbackSource]);

  // ALO-146/147/213: seek to ?t= when present, otherwise resume from
  // localStorage (unless ?start=1 forces a fresh play). Runs once per
  // loadedmetadata so we know the duration before deciding.
  useEffect(() => {
    const player = playerRef.current;
    if (!id || !player) return;
    let applied = false;
    const onLoaded = (): void => {
      if (applied) return;
      applied = true;
      const p = playerRef.current;
      if (!p) return;
      const duration = p.duration();
      const stored = loadStoredPosition(id, window.localStorage);
      const resumable = shouldResumeAt(stored, duration > 0 ? duration : null);
      if (startAt == null && !watchFromStart && resumable != null && resumable > 0) {
        setResumeOffer(resumable);
      }
      // ?t= wins; otherwise resume only when not overridden.
      const target =
        startAt != null
          ? startAt
          : watchFromStart
            ? null
            : resumable;
      if (target != null && target > 0) {
        const safe = duration > 0 ? Math.min(target, duration - 1) : target;
        p.setCurrentTime(safe);
      }
    };
    player.on('loadedmetadata', onLoaded);
    if (player.readyState() >= 1) {
      onLoaded();
    }
    return () => {
      player.off('loadedmetadata', onLoaded);
    };
  }, [id, playbackSource, startAt, watchFromStart]);

  // ALO-146: persist position. Save while playing on a 5s tick, on pause,
  // and on tab hide (which is when most viewers vanish without "ending").
  useEffect(() => {
    const player = playerRef.current;
    if (!id || !player) return;

    const p0 = player; // captured; survives playerRef being nulled on dispose
    const persist = (): void => {
      const p = playerRef.current ?? p0;
      if (!p) return;
      saveStoredPosition(id, p.currentTime(), window.localStorage);
    };
    const tick = (): void => {
      const p = playerRef.current;
      if (!p || p.paused()) return;
      persist();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') persist();
    };

    const interval = window.setInterval(tick, POSITION_SAVE_INTERVAL_MS);
    player.on('pause', persist);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', persist);
    return () => {
      window.clearInterval(interval);
      persist();
      player.off('pause', persist);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', persist);
    };
  }, [id, playbackSource]);

  // ALO-188: window-level keyboard shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = keyToPlayerAction(event);
      if (!action) return;
      const p = playerRef.current;
      if (!p) return;
      event.preventDefault();
      switch (action.type) {
        case 'toggle-play':
          if (p.paused()) {
            void p.play();
          } else {
            p.pause();
          }
          return;
        case 'seek-relative': {
          const duration = p.duration();
          const current = p.currentTime();
          const next = Math.max(0, duration > 0 ? Math.min(current + action.seconds, duration) : current + action.seconds);
          p.setCurrentTime(next);
          return;
        }
        case 'seek-percent': {
          // ALO-212: digit keys jump to a fraction of duration. Skip when
          // duration is unknown (live or pre-metadata) so we don't seek to NaN.
          const duration = p.duration();
          if (duration <= 0) return;
          const target = Math.min(duration - 1, (duration * action.percent) / 100);
          p.setCurrentTime(Math.max(0, target));
          return;
        }
        case 'toggle-fullscreen':
          if (p.isFullscreen()) {
            void p.exitFullscreen();
          } else {
            void p.requestFullscreen();
          }
          return;
        case 'toggle-mute':
          p.setMuted(!p.muted());
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playbackSource]);

  // ALO-153: when the current video ends and auto-advance is on, navigate to
  // the first up-next entry. Reads from refs so we don't rebind the listener
  // every time autoAdvance / upNext change.
  useEffect(() => {
    const player = playerRef.current;
    if (!id || !player) return;
    const onEnded = (): void => {
      if (!autoAdvanceRef.current) return;
      const next = upNextRef.current[0];
      if (!next) return;
      navigate(`/watch/${next.id}`);
    };
    player.on('ended', onEnded);
    return () => {
      player.off('ended', onEnded);
    };
  }, [id, navigate, playbackSource]);

  useEffect(() => {
    const player = playerRef.current;
    if (!id || !player) return;
    const HEARTBEAT_MS = 10_000;
    let lastTick = Date.now();

    const ping = (): void => {
      const p = playerRef.current;
      if (!p || p.paused()) {
        lastTick = Date.now();
        return;
      }
      const now = Date.now();
      const delta = Math.min(60, Math.max(0, (now - lastTick) / 1000));
      lastTick = now;
      if (delta < 1) return;
      const position = p.currentTime();
      void fetch(`/api/videos/${encodeURIComponent(id)}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta, position }),
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => undefined);
    };

    const interval = window.setInterval(ping, HEARTBEAT_MS);
    const onPlay = (): void => {
      lastTick = Date.now();
    };
    player.on('play', onPlay);
    return () => {
      window.clearInterval(interval);
      ping();
      player.off('play', onPlay);
    };
  }, [id, playbackSource]);

  // ALO-213: dismiss the resume banner and rewind to 0. Clears storage so
  // the next visit doesn't re-offer the same position.
  const startFromBeginning = useCallback((): void => {
    if (!id) return;
    clearStoredPosition(id, window.localStorage);
    setResumeOffer(null);
    const p = playerRef.current;
    if (p) {
      p.setCurrentTime(0);
    }
  }, [id]);

  const shareAtCurrentTime = useCallback(async (): Promise<void> => {
    const p = playerRef.current;
    if (!p) return;
    const t = Math.floor(p.currentTime());
    const url = new URL(window.location.href);
    if (t > 0) {
      url.searchParams.set('t', formatTimeParam(t));
    } else {
      url.searchParams.delete('t');
    }
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable on insecure contexts; fall back to
      // updating the address bar so the user can copy manually.
      window.history.replaceState(null, '', url.toString());
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    }
  }, []);

  if (error) {
    return (
      <main className="app-main stack">
        <p className="status-error">{error}</p>
      </main>
    );
  }

  if (!video) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg fade-in">
      <div
        className="card--tight"
        style={{
          padding: 0,
          overflow: 'hidden',
          borderRadius: 'var(--radius-2xl)',
          border: '1px solid color-mix(in oklch, var(--border), transparent 30%)',
          background: 'oklch(0 0 0)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <video
          ref={videoEl}
          className="native-player"
          playsInline
          preload="metadata"
          style={{ width: '100%', display: 'block', background: 'black' }}
        />
      </div>
      {resumeOffer != null && (
        <div
          role="status"
          aria-live="polite"
          className="row"
          style={{
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            border: '1px solid color-mix(in oklch, var(--border), transparent 40%)',
            borderRadius: 'var(--radius-lg)',
            background: 'color-mix(in oklch, var(--accent), transparent 92%)',
            flexWrap: 'wrap',
          }}
        >
          <span className="ds-meta" style={{ flex: 1, minWidth: 0 }}>
            Resumed at {formatHms(resumeOffer)}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={startFromBeginning}
          >
            Watch from start
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setResumeOffer(null)}
            aria-label="Dismiss resume banner"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="stack-sm">
        <h1 className="ds-h2">{video.title}</h1>
        <div className="row">
          <span className="badge">{video.view_count} views</span>
          <span className="badge">{video.channel_name ?? 'Unknown channel'}</span>
        </div>
      </div>
      <p>{video.description}</p>
      <Suspense fallback={null}>
        <VideoTags videoId={video.id} />
      </Suspense>
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={likes?.liked ? 'btn' : 'btn btn--secondary'}
          onClick={() => {
            void toggleLike();
          }}
          disabled={likeBusy}
          aria-pressed={likes?.liked ?? false}
        >
          {likes?.liked ? '♥ Liked' : '♡ Like'}
          {likes ? ` · ${likes.count}` : ''}
        </button>
        <button
          type="button"
          className={sub?.subscribed ? 'btn btn--secondary' : 'btn'}
          onClick={() => {
            void toggleSubscribe();
          }}
          disabled={subBusy || !channelUsername}
          aria-pressed={sub?.subscribed ?? false}
        >
          {sub?.subscribed ? 'Subscribed' : 'Subscribe'}
          {sub ? ` · ${sub.subscriberCount}` : ''}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            void shareAtCurrentTime();
          }}
          aria-live="polite"
        >
          {shareCopied ? 'Link copied' : 'Share at current time'}
        </button>
        {id ? (
          <Suspense fallback={null}>
            <ReportButton targetType="video" targetId={id} />
          </Suspense>
        ) : null}
      </div>
      {/* ALO-158: web-intent links — no third-party SDKs, no tracking. The
          share URL omits ?t= so a re-watch starts from 0 by default. */}
      <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span className="ds-meta">Share to:</span>
        {(() => {
          const shareUrl =
            typeof window !== 'undefined' ? `${window.location.origin}/watch/${id ?? ''}` : '';
          const shareTitle = video.title;
          const enc = encodeURIComponent;
          const links: Array<{ label: string; href: string }> = [
            {
              label: 'Twitter',
              href: `https://twitter.com/intent/tweet?url=${enc(shareUrl)}&text=${enc(shareTitle)}`,
            },
            {
              label: 'Facebook',
              href: `https://www.facebook.com/sharer/sharer.php?u=${enc(shareUrl)}`,
            },
            {
              label: 'Reddit',
              href: `https://www.reddit.com/submit?url=${enc(shareUrl)}&title=${enc(shareTitle)}`,
            },
          ];
          return links.map((l) => (
            <a
              key={l.label}
              className="btn btn--ghost btn--sm"
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {l.label}
            </a>
          ));
        })()}
      </div>
      {likeError ? <p className="status-error">{likeError}</p> : null}
      {subError ? <p className="status-error">{subError}</p> : null}
      <p className="ds-meta">
        Shortcuts: space/k play · j/l ±10s · ←/→ ±5s · 0–9 jump · f fullscreen · m mute
      </p>
      {upNext.length > 0 ? (
        <section className="stack-sm" aria-label="Up next">
          <div
            className="row"
            style={{ alignItems: 'baseline', justifyContent: 'space-between' }}
          >
            <h2 className="ds-h3" style={{ margin: 0 }}>Up next</h2>
            <label
              className="ds-meta"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={toggleAutoAdvance}
                aria-label="Auto-advance to the next video when this one ends"
              />
              Autoplay
            </label>
          </div>
          <ul
            className="stack-sm"
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
          >
            {upNext.map((v) => (
              <li key={v.id}>
                <Link
                  to={`/watch/${v.id}`}
                  className="row"
                  style={{
                    gap: 'var(--space-2)',
                    alignItems: 'flex-start',
                    textDecoration: 'none',
                    color: 'inherit',
                    padding: 'var(--space-1)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  {v.thumbnail_url ? (
                    <img
                      src={v.thumbnail_url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: 160,
                        aspectRatio: '16/9',
                        objectFit: 'cover',
                        borderRadius: 'var(--radius-sm)',
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{v.title}</div>
                    <div className="ds-meta" style={{ marginTop: 2 }}>
                      {v.channel_name ?? 'Unknown channel'} · {v.view_count} views
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {id ? <CommentsSection videoId={id} /> : null}
    </main>
  );
}

// ALO-283: Comments is the largest below-the-fold chunk. Wait until its
// placeholder scrolls within ~600px of the viewport before kicking off the
// dynamic import so users who never scroll never pay for it.
function CommentsSection({ videoId }: { videoId: string }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Old browsers / SSR — just render immediately and let Suspense handle it.
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  return (
    <div ref={ref} style={{ minHeight: 120 }}>
      {visible ? (
        <Suspense fallback={<p className="ds-meta">Loading comments…</p>}>
          <Comments videoId={videoId} />
        </Suspense>
      ) : null}
    </div>
  );
}
