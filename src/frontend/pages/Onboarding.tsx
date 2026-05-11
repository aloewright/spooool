import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { hasCompletedOnboarding, markOnboardingComplete } from '../lib/onboarding';

type Step = 'username' | 'avatar' | 'first-upload';

const STEPS: Step[] = ['username', 'avatar', 'first-upload'];

type UserProfile = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

async function loadProfile(): Promise<UserProfile> {
  const res = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to load profile');
  return (await res.json()) as UserProfile;
}

async function saveUsername(username: string): Promise<void> {
  const res = await fetch('/api/users/me', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Could not save username');
  }
}

async function uploadAvatar(file: File): Promise<void> {
  const formData = new FormData();
  formData.set('file', file);
  const res = await fetch('/api/users/me/avatar', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Could not upload avatar');
  }
}

function track(event: string, props: Record<string, unknown> = {}): void {
  void import('../lib/analytics').then(({ track: emit }) => emit(event, props));
}

export function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [stepIndex, setStepIndex] = useState(0);
  // Latest stepIndex in a ref so advance()/skip() decide based on the
  // live value, not the value captured when the in-flight async handler
  // was created. Without this, a Skip click during an upload would let
  // the upload's success handler advance past the last step.
  const stepIndexRef = useRef(0);
  const [username, setUsername] = useState('');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = STEPS[stepIndex];

  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    void loadProfile()
      .then((data) => {
        if (cancelled) return;
        setProfile(data);
        setUsername(data.username ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Pre-fill is best-effort — fall back to empty inputs but
        // surface the failure so observability picks it up.
        console.error('onboarding: failed to load profile', err);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  // Only emit step-view events once we know the user is signed in; otherwise
  // we burn a dynamic-import + posthog round-trip for sessions that bounce
  // straight back to /login.
  useEffect(() => {
    if (!session?.user) return;
    track('onboarding_step_viewed', { step });
  }, [session?.user, step]);

  const finish = useCallback((): void => {
    if (!session?.user) return;
    markOnboardingComplete(session.user.id, window.localStorage);
    // Always tag the completion event with the step we were on so funnel
    // analytics can tell "finished via Continue" from "bailed via Maybe later".
    track('onboarding_completed', { exited_from: stepIndexRef.current });
    navigate('/', { replace: true });
  }, [navigate, session?.user]);

  const advance = useCallback((): void => {
    setError(null);
    if (stepIndexRef.current >= STEPS.length - 1) {
      finish();
      return;
    }
    stepIndexRef.current += 1;
    setStepIndex(stepIndexRef.current);
  }, [finish]);

  const skip = useCallback((): void => {
    track('onboarding_step_skipped', { step });
    advance();
  }, [advance, step]);

  const submitUsername = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const value = username.trim();
      if (!value) {
        skip();
        return;
      }
      setError(null);
      setBusy(true);
      try {
        await saveUsername(value);
        track('onboarding_username_saved', {});
        advance();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not save username');
      } finally {
        setBusy(false);
      }
    },
    [advance, skip, username],
  );

  const onAvatarPicked = useCallback(
    async (file: File | null): Promise<void> => {
      if (!file) return;
      setError(null);
      setBusy(true);
      try {
        await uploadAvatar(file);
        track('onboarding_avatar_uploaded', {});
        advance();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not upload avatar');
      } finally {
        setBusy(false);
      }
    },
    [advance],
  );

  const progress = useMemo(() => `${stepIndex + 1} of ${STEPS.length}`, [stepIndex]);

  if (isPending) {
    return (
      <main className="app-main app-main--narrow stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }

  if (!session?.user) {
    return <Navigate to="/login" replace />;
  }

  // Already done — drop the user back to home instead of letting them
  // bounce into the flow a second time via bookmark or back button.
  if (hasCompletedOnboarding(session.user.id, window.localStorage)) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-6)' }}>
        <span className="ds-label">Welcome · Step {progress}</span>
        <h1 className="ds-h2">Get set up in a minute</h1>
        <p className="ds-lede">Three quick steps and you're ready to upload.</p>
      </div>

      {step === 'username' ? (
        <form onSubmit={(e) => void submitUsername(e)} className="card stack">
          <div className="field">
            <label className="field__label" htmlFor="onboarding-username">
              Pick a username
            </label>
            <input
              id="onboarding-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alex_99"
              autoFocus
            />
            <span className="ds-meta">
              Lowercase letters, numbers, _ or -. 2–30 chars. Leave blank to skip.
            </span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={skip}>
              Skip
            </button>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'avatar' ? (
        <section className="card stack">
          <div className="stack-sm">
            <span className="ds-label">Avatar</span>
            <h2 className="ds-h3">Add a profile photo</h2>
            <p className="ds-meta">JPEG, PNG, or WebP. Up to 2 MB.</p>
          </div>
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt="Current avatar"
              decoding="async"
              loading="lazy"
              style={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : null}
          <input
            type="file"
            className="input"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => void onAvatarPicked(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={skip}>
              Skip
            </button>
            <button type="button" className="btn btn--secondary" onClick={advance} disabled={busy}>
              {busy ? 'Uploading…' : 'Continue'}
            </button>
          </div>
        </section>
      ) : null}

      {step === 'first-upload' ? (
        <section className="card stack">
          <div className="stack-sm">
            <span className="ds-label">Almost there</span>
            <h2 className="ds-h3">Upload your first video</h2>
            <p>
              Drop in an MP4, WebM, MOV, or MKV. We'll transcode it and have it ready
              for the world in minutes.
            </p>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={finish}>
              Maybe later
            </button>
            <Link
              to="/upload"
              className="btn"
              onClick={() => {
                track('onboarding_upload_clicked', {});
                markOnboardingComplete(session.user.id, window.localStorage);
              }}
            >
              Upload a video
            </Link>
          </div>
        </section>
      ) : null}

      {error ? <p className="status-error">{error}</p> : null}
    </main>
  );
}
