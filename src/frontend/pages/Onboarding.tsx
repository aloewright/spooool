import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import {
  loadOnboardingState,
  saveOnboardingState,
  shouldRunOnboarding,
  type OnboardingState,
} from '../lib/onboarding';

interface UserProfile {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

type Step = 1 | 2 | 3;
const STEP_TITLES: Record<Step, string> = {
  1: 'Pick a username',
  2: 'Add an avatar',
  3: 'Upload your first clip',
};

async function loadProfile(): Promise<UserProfile> {
  const res = await fetch('/api/users/me', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Failed to load profile');
  return (await res.json()) as UserProfile;
}

async function saveUsername(username: string): Promise<UserProfile> {
  const res = await fetch('/api/users/me', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Username could not be saved');
  }
  return (await res.json()) as UserProfile;
}

async function uploadAvatar(file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.set('file', file);
  const res = await fetch('/api/users/me/avatar', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Avatar upload failed');
  }
  return (await res.json()) as { url: string };
}

function emitTrack(event: string, properties: Record<string, unknown>): void {
  // analytics is lazy-loaded in main.tsx — same pattern used by Signup so the
  // onboarding bundle stays small and we never require posthog at render
  // time.
  void import('../lib/analytics').then(({ track }) => track(event, properties));
}

export function Onboarding(): JSX.Element {
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = useSession();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [username, setUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [didStart, setDidStart] = useState(false);

  // Hydrate the saved per-device state once so we know whether to record an
  // `onboarding_started` event (first time only).
  const initialState = useMemo<OnboardingState>(() => loadOnboardingState(), []);

  useEffect(() => {
    if (sessionPending) return;
    if (!session) {
      navigate('/login', { replace: true, state: { from: '/welcome' } });
      return;
    }
    let cancelled = false;
    void loadProfile()
      .then((data) => {
        if (cancelled) return;
        setProfile(data);
        setUsername(data.username ?? '');
        // If a user finished part of the flow elsewhere (e.g. set their
        // username on another device), jump to the next unfinished step
        // rather than re-asking.
        if (data.username && !data.avatarUrl) setStep(2);
        else if (data.username && data.avatarUrl) setStep(3);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load profile');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, session, sessionPending]);

  useEffect(() => {
    if (didStart || !profile) return;
    if (initialState.status === 'pending' && initialState.step === 0) {
      emitTrack('onboarding_started', { step: 1 });
    }
    setDidStart(true);
  }, [didStart, initialState, profile]);

  function persist(next: Partial<OnboardingState>): void {
    const current = loadOnboardingState();
    saveOnboardingState({ ...current, ...next });
  }

  function finish(reason: 'completed' | 'skipped', fromStep: Step): void {
    persist({ status: reason, step: fromStep });
    emitTrack(reason === 'completed' ? 'onboarding_completed' : 'onboarding_skipped', {
      step: fromStep,
    });
    navigate('/', { replace: true });
  }

  function skipCurrentStep(): void {
    emitTrack('onboarding_step_skipped', { step });
    if (step === 3) {
      finish('skipped', step);
      return;
    }
    persist({ step });
    setStep((s) => (s + 1) as Step);
    setError(null);
    setStatus(null);
  }

  async function onSubmitUsername(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const value = username.trim();
    if (!value) {
      setError('Pick a username to continue, or skip this step.');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await saveUsername(value);
      setProfile(updated);
      emitTrack('onboarding_step_completed', { step: 1 });
      persist({ step: 1 });
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Username could not be saved');
    } finally {
      setSubmitting(false);
    }
  }

  async function onPickAvatar(file: File | null): Promise<void> {
    if (!file) return;
    setError(null);
    setStatus(null);
    setSubmitting(true);
    try {
      const { url } = await uploadAvatar(file);
      setProfile((prev) => (prev ? { ...prev, avatarUrl: url } : prev));
      setStatus('Avatar uploaded');
      emitTrack('onboarding_step_completed', { step: 2 });
      persist({ step: 2 });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Avatar upload failed');
    } finally {
      setSubmitting(false);
    }
  }

  function goToUpload(): void {
    emitTrack('onboarding_step_completed', { step: 3 });
    persist({ status: 'completed', step: 3 });
    emitTrack('onboarding_completed', { step: 3 });
    navigate('/upload', { replace: true });
  }

  if (sessionPending || (!profile && !error)) {
    return (
      <main className="app-main app-main--narrow stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in onboarding">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-6)' }}>
        <span className="ds-label">Welcome to spooool</span>
        <h1 className="ds-h2">{STEP_TITLES[step]}</h1>
        <p className="ds-meta">Step {step} of 3 · skip any step you don&rsquo;t need.</p>
      </div>

      <ol className="onboarding__steps" aria-label="Onboarding progress">
        {[1, 2, 3].map((n) => (
          <li
            key={n}
            className={`onboarding__step ${n === step ? 'onboarding__step--active' : ''} ${
              n < step ? 'onboarding__step--done' : ''
            }`}
          >
            <span aria-hidden="true">{n}</span>
            <span className="onboarding__step-label">{STEP_TITLES[n as Step]}</span>
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <form onSubmit={(e) => void onSubmitUsername(e)} className="card stack">
          <div className="field">
            <label className="field__label" htmlFor="onboarding-username">
              Username
            </label>
            <input
              id="onboarding-username"
              className="input"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alex_99"
              autoComplete="off"
            />
            <span className="ds-meta">
              Lowercase letters, numbers, _ or -. 2&ndash;30 characters. People will see this on
              your channel URL.
            </span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={skipCurrentStep}
              disabled={submitting}
            >
              Skip for now
            </button>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 2 ? (
        <section className="card stack">
          <p className="ds-meta">
            Drop a JPEG, PNG, or WebP up to 2MB. You can change this any time from your profile.
          </p>
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
            disabled={submitting}
            onChange={(e) => void onPickAvatar(e.target.files?.[0] ?? null)}
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={skipCurrentStep}
              disabled={submitting}
            >
              Skip for now
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                emitTrack('onboarding_step_completed', { step: 2 });
                persist({ step: 2 });
                setStep(3);
              }}
              disabled={submitting}
            >
              {profile?.avatarUrl ? 'Continue' : 'Continue without avatar'}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="card stack">
          <p>
            You&rsquo;re set up. Drop a clip and we&rsquo;ll handle the rest &mdash; transcoding,
            thumbnails, the whole thing.
          </p>
          <p className="ds-meta">
            Got nothing handy right now? No problem &mdash; you can come back from the home page any
            time.
          </p>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => finish('skipped', 3)}
            >
              I&rsquo;ll do this later
            </button>
            <button type="button" className="btn" onClick={goToUpload}>
              Upload a video
            </button>
          </div>
        </section>
      ) : null}

      {error ? <p className="status-error">{error}</p> : null}
      {status ? <p className="status-ok">{status}</p> : null}
    </main>
  );
}

// Re-exported so callers (App.tsx) can decide whether to redirect a freshly
// signed-in user to the welcome flow.
export { shouldRunOnboarding };
