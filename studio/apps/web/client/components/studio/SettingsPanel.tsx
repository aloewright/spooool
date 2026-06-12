import { useNavigate } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "../../lib/auth-client";
import {
  type ColorTheme,
  type ThemePreference,
  getColorTheme,
  getThemePreference,
  setColorTheme,
  setThemePreference,
} from "../../lib/theme";
import { colorThemes } from "../../lib/tweakcn-themes";

const THEME_MODES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ThemePreference>("system");
  const [color, setColor] = useState<ColorTheme>("book-cook");
  const [signingOut, setSigningOut] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setMode(getThemePreference());
    setColor(getColorTheme());
  }, [open]);

  function pickMode(next: ThemePreference) {
    setMode(next);
    setThemePreference(next);
  }

  function pickColor(next: ColorTheme) {
    setColor(next);
    setColorTheme(next);
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await authClient.signOut();
      onClose();
      navigate({ to: "/sign-in", replace: true });
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
          <div className="grid grid-cols-3 gap-1.5">
            {THEME_MODES.map((m) => (
              <button
                key={m.value}
                aria-pressed={mode === m.value}
                className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition ${
                  mode === m.value
                    ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-50 dark:text-neutral-900"
                    : "bg-black/5 text-neutral-700 hover:bg-black/10 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10"
                }`}
                onClick={() => pickMode(m.value)}
                type="button"
              >
                <m.icon className="size-3.5" />
                {m.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-[11px] text-neutral-500 uppercase tracking-wide">Palette</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {colorThemes.slice(0, 8).map((t) => (
              <button
                key={t.name}
                aria-pressed={color === t.name}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                  color === t.name
                    ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-50 dark:text-neutral-900"
                    : "bg-black/5 text-neutral-700 hover:bg-black/10 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10"
                }`}
                onClick={() => pickColor(t.name)}
                type="button"
              >
                <span
                  className="inline-block size-3 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                  style={{ backgroundColor: t.primaryLight }}
                />
                {t.title}
              </button>
            ))}
          </div>
        </section>

        <section>
          <button
            className="flex w-full items-center justify-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-red-600 text-sm hover:bg-red-500/20 dark:text-red-400"
            disabled={signingOut}
            onClick={handleSignOut}
            type="button"
          >
            <LogOut className="size-3.5" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </section>
      </div>
    </div>
  );
}
