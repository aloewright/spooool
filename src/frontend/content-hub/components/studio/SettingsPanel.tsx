// Settings dialog — ported from
// studio/apps/web/client/components/studio/SettingsPanel.tsx.
//
// STUBBED for spooool (PR-3 workspace shell):
//   - The studio source carried Appearance (light/dark/system) + Palette
//     (tweakcn color themes) controls backed by lib/theme + lib/tweakcn-themes.
//     That theme infrastructure has NOT been ported to spooool yet, and the
//     content-hub renders light-only inside `.studio-scope`. So those two
//     sections are deferred (a short "coming soon" note stands in their place)
//     rather than importing modules that don't exist. They can be restored when
//     the theme store lands.
//   - Sign out uses spooool's better-auth client (signOut from
//     ../../../lib/auth-client) and lands on /login — the studio source called
//     authClient.signOut() then navigated to /sign-in, which is /login here.
import { useNavigate } from '@tanstack/react-router';
import { LogOut, X } from 'lucide-react';
import { useState } from 'react';
import { signOut } from '../../../lib/auth-client';

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      onClose();
      navigate({ to: '/login', replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:items-center sm:justify-center">
      <button
        aria-label="Close settings"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div className="relative w-full max-w-md rounded-2xl bg-neutral-50 p-5 text-neutral-900 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-900 dark:text-neutral-100 dark:ring-white/10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-xl tracking-tight">Settings</h2>
          <button
            aria-label="Close"
            className="rounded-md p-1 hover:bg-black/5 dark:hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>

        <section className="mb-5">
          <h3 className="mb-2 text-[11px] text-neutral-500 uppercase tracking-wide">Appearance</h3>
          <p className="rounded-md bg-black/5 px-3 py-2 text-neutral-500 text-sm dark:bg-white/5">
            Theme & palette controls are coming soon.
          </p>
        </section>

        <section>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-red-600 text-sm hover:bg-red-500/20 dark:text-red-400"
            disabled={signingOut}
            onClick={handleSignOut}
            type="button"
          >
            <LogOut className="size-3.5" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </section>
      </div>
    </div>
  );
}
