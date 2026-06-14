import { appBase } from "./app-base";
import { DEFAULT_COLOR_THEME, allColorThemeValues } from "./tweakcn-themes";

// Served via spooool.com/studio the studio defaults to spooool's design
// system; explicit user choices (per-origin localStorage) still win.
const BASE_DEFAULT_COLOR_THEME = appBase ? "spooool" : DEFAULT_COLOR_THEME;

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "book-cook-theme";
const COLOR_STORAGE_KEY = "book-cook-color-theme";

export type ColorTheme = string;

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function setThemePreference(preference: ThemePreference) {
  window.localStorage.setItem(STORAGE_KEY, preference);
  applyThemePreference(preference);
}

export function getColorTheme(): ColorTheme {
  if (typeof window === "undefined") return BASE_DEFAULT_COLOR_THEME;
  const stored = window.localStorage.getItem(COLOR_STORAGE_KEY);
  return stored && allColorThemeValues.includes(stored) ? stored : BASE_DEFAULT_COLOR_THEME;
}

export function setColorTheme(theme: ColorTheme) {
  const next = allColorThemeValues.includes(theme) ? theme : BASE_DEFAULT_COLOR_THEME;
  window.localStorage.setItem(COLOR_STORAGE_KEY, next);
  applyThemePreference();
}

export function resolveThemeMode(preference = getThemePreference()): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return preference === "dark" || (preference === "system" && prefersDark) ? "dark" : "light";
}

export function applyThemePreference(
  preference = getThemePreference(),
  colorTheme = getColorTheme(),
) {
  if (typeof window === "undefined") return;
  const mode = resolveThemeMode(preference);
  const safeColorTheme = allColorThemeValues.includes(colorTheme)
    ? colorTheme
    : BASE_DEFAULT_COLOR_THEME;
  document.documentElement.dataset.theme = `${safeColorTheme}-${mode}`;
  document.documentElement.classList.toggle("dark", mode === "dark");
}

export function watchSystemTheme() {
  if (typeof window === "undefined") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => {
    if (getThemePreference() === "system") applyThemePreference("system");
  };
  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
}
