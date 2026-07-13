// Theme registry for the Handy theming engine.
//
// A theme is just a set of `--color-*` values, defined as a
// `:root[data-theme="<id>"]` block in `src/styles/theme.css`. This module owns
// the list of themes and the pure logic for turning a stored theme id (which may
// be "system" or an unknown/legacy value) into the concrete id to stamp onto
// `<html data-theme>`. Adding a theme is a CSS block + one entry here — no
// backend change.

export type Appearance = "light" | "dark";

export interface ThemeDef {
  /** Stable id persisted in settings and used as the `data-theme` value. */
  id: string;
  /** Human-facing name (proper noun; not translated). */
  label: string;
  appearance: Appearance;
}

export const THEMES: ThemeDef[] = [
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", appearance: "light" },
  { id: "handy-light", label: "Handy Light", appearance: "light" },
  { id: "handy-dark", label: "Handy Dark", appearance: "dark" },
];

/** Sentinel id meaning "follow the OS light/dark preference". */
export const SYSTEM_THEME = "system";

/** Default + flagship theme. */
export const DEFAULT_THEME = "tokyo-night";

/** Concrete themes "system" resolves to, per OS appearance. */
export const SYSTEM_LIGHT = "handy-light";
export const SYSTEM_DARK = "handy-dark";

/** Key used to cache the resolved theme for flash-free startup. */
export const THEME_STORAGE_KEY = "handy-theme";

const THEME_IDS = new Set(THEMES.map((t) => t.id));

export const isKnownTheme = (id: string): boolean => THEME_IDS.has(id);

/**
 * Resolve a stored theme id to the concrete theme id to apply.
 * - "system" → the light or dark member of the system pair, per `prefersDark`.
 * - a known theme id → itself.
 * - anything else (unknown/legacy) → the default theme.
 * Pure and DOM-free so it can be unit-tested directly.
 */
export function resolveTheme(id: string, prefersDark: boolean): string {
  if (id === SYSTEM_THEME) {
    return prefersDark ? SYSTEM_DARK : SYSTEM_LIGHT;
  }
  return isKnownTheme(id) ? id : DEFAULT_THEME;
}

/**
 * Light/dark appearance a stored theme id resolves to. The backend persists this
 * so it can theme the Windows title bar (which CSS `data-theme` cannot reach)
 * without duplicating this registry. Pure, like `resolveTheme`, so it is unit
 * testable; the caller supplies the OS preference.
 */
export function resolveAppearance(
  id: string,
  prefersDark: boolean,
): Appearance {
  const concrete = resolveTheme(id, prefersDark);
  return THEMES.find((theme) => theme.id === concrete)?.appearance ?? "dark";
}

/** Options shown in the theme picker: the concrete themes plus "System". */
export const THEME_OPTIONS: { id: string }[] = [
  ...THEMES.map((t) => ({ id: t.id })),
  { id: SYSTEM_THEME },
];

// --- DOM / persistence helpers (side-effecting; not part of the pure core) ---

/** Whether the OS currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Stamp the resolved theme onto `<html data-theme>`. */
export function applyTheme(preferenceId: string): void {
  const concrete = resolveTheme(preferenceId, systemPrefersDark());
  document.documentElement.setAttribute("data-theme", concrete);
}

/** Persist the user's theme *preference* (may be "system") for flash-free startup. */
export function cacheThemePreference(preferenceId: string): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preferenceId);
  } catch {
    // localStorage may be unavailable; caching is best-effort.
  }
}

/** Read the cached theme preference, falling back to the default. */
export function readCachedThemePreference(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}
