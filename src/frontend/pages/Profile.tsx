import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

interface UserProfile {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
}

async function loadProfile(): Promise<UserProfile> {
  const res = await fetch('/api/users/me');
  if (!res.ok) throw new Error('Failed to load profile');
  return (await res.json()) as UserProfile;
}

async function saveProfile(payload: {
  username?: string;
  displayName?: string;
  bio?: string;
}): Promise<UserProfile> {
  const res = await fetch('/api/users/me', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Failed to save profile');
  }
  return (await res.json()) as UserProfile;
}

async function uploadImage(field: 'avatar' | 'banner', file: File): Promise<{ url: string }> {
  const formData = new FormData();
  formData.set('file', file);
  const res = await fetch(`/api/users/me/${field}`, { method: 'POST', body: formData });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to upload ${field}`);
  }
  return (await res.json()) as { url: string };
}

type StripeConnectStatus =
  | { connected: false; chargesEnabled: false }
  | { connected: true; chargesEnabled: boolean; payoutsEnabled: boolean };

export function Profile(): JSX.Element {
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stripeStatus, setStripeStatus] = useState<StripeConnectStatus | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);

  // Load Stripe Connect status on mount and after returning from onboarding.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/users/me/stripe/connect', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as StripeConnectStatus;
        if (!cancelled) setStripeStatus(data);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [searchParams.get('stripe')]);

  useEffect(() => {
    let cancelled = false;
    void loadProfile()
      .then((data) => {
        if (cancelled) return;
        setProfile(data);
        setUsername(data.username ?? '');
        setDisplayName(data.displayName ?? data.name ?? '');
        setBio(data.bio ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load profile');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus(null);
    try {
      const updated = await saveProfile({
        username: username.trim() || undefined,
        displayName: displayName.trim() || undefined,
        bio,
      });
      setProfile(updated);
      setStatus('Saved');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function connectStripe(): Promise<void> {
    setStripeLoading(true);
    setStripeError(null);
    try {
      const res = await fetch('/api/users/me/stripe/connect', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to start Stripe onboarding');
      }
      const { url } = (await res.json()) as { url: string };
      window.location.href = url;
    } catch (err: unknown) {
      setStripeError(err instanceof Error ? err.message : 'Failed to connect Stripe');
      setStripeLoading(false);
    }
  }

  async function onPickImage(field: 'avatar' | 'banner', file: File | null): Promise<void> {
    if (!file) return;
    setError(null);
    try {
      const { url } = await uploadImage(field, file);
      setProfile((prev) => (prev ? { ...prev, [`${field}Url`]: url } : prev));
      setStatus(`${field === 'avatar' ? 'Avatar' : 'Banner'} updated`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to upload ${field}`);
    }
  }

  if (!profile && !error) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-main app-main--narrow stack-xl fade-in">
      <div className="stack-sm">
        <span className="ds-label">Profile</span>
        <h1 className="ds-h2">Your channel</h1>
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="card stack">
        <div className="field">
          <label className="field__label" htmlFor="profile-username">
            Username
          </label>
          <input
            id="profile-username"
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alex_99"
          />
          <span className="ds-meta">Lowercase letters, numbers, _ or -. 2–30 chars.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="profile-display">
            Display name
          </label>
          <input
            id="profile-display"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="profile-bio">
            Bio
          </label>
          <textarea
            id="profile-bio"
            className="input"
            rows={4}
            maxLength={500}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
          />
          <span className="ds-meta">Up to 500 characters.</span>
        </div>

        <div>
          <button type="submit" className="btn">
            Save profile
          </button>
        </div>
      </form>

      <section className="card stack-sm">
        <span className="ds-label">Avatar</span>
        {profile?.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt="Current avatar"
            decoding="async"
            loading="lazy"
            style={{ width: 96, height: 96, borderRadius: '50%', objectFit: 'cover' }}
          />
        ) : (
          <p className="ds-meta">No avatar uploaded.</p>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => void onPickImage('avatar', e.target.files?.[0] ?? null)}
        />
        <span className="ds-meta">JPEG/PNG/WebP, up to 2MB.</span>
      </section>

      <section className="card stack-sm">
        <span className="ds-label">Banner</span>
        {profile?.bannerUrl ? (
          <img
            src={profile.bannerUrl}
            alt="Current banner"
            decoding="async"
            loading="lazy"
            style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 8 }}
          />
        ) : (
          <p className="ds-meta">No banner uploaded.</p>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => void onPickImage('banner', e.target.files?.[0] ?? null)}
        />
        <span className="ds-meta">JPEG/PNG/WebP, up to 5MB.</span>
      </section>

      <section className="card stack-sm">
        <span className="ds-label">Tipping</span>
        <p className="ds-meta">
          Connect a Stripe account to receive tips from viewers. Spooool takes a 10% platform fee;
          you keep the rest minus Stripe processing fees.
        </p>
        {stripeStatus?.connected && stripeStatus.chargesEnabled ? (
          <p className="status-ok">
            Stripe connected — tipping is enabled on your videos.
          </p>
        ) : stripeStatus?.connected && !stripeStatus.chargesEnabled ? (
          <>
            <p className="ds-meta">Onboarding incomplete — finish setting up your Stripe account.</p>
            <button
              type="button"
              className="btn"
              onClick={() => void connectStripe()}
              disabled={stripeLoading}
            >
              {stripeLoading ? 'Redirecting…' : 'Resume Stripe setup'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => void connectStripe()}
            disabled={stripeLoading}
          >
            {stripeLoading ? 'Redirecting…' : 'Connect Stripe to enable tipping'}
          </button>
        )}
        {stripeError ? <p className="status-error">{stripeError}</p> : null}
      </section>

      {error ? <p className="status-error">{error}</p> : null}
      {status ? <p className="status-ok">{status}</p> : null}
    </main>
  );
}
