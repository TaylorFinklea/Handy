import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { applyTheme, cacheThemePreference, SYSTEM_THEME } from "../lib/themes";

/**
 * Applies the persisted theme and keeps it in sync. Mounted once near the app
 * root. `main.tsx` already stamped the cached theme before first paint, so this
 * hook waits for settings to load before touching `data-theme` again — avoiding a
 * flash back to the default. In System mode it follows OS light/dark changes live.
 */
export function useTheme(): void {
  const theme = useSettingsStore((s) => s.settings?.theme);

  useEffect(() => {
    // Settings not loaded yet — keep the theme main.tsx applied from cache.
    if (theme === undefined) return;
    applyTheme(theme);
    cacheThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== SYSTEM_THEME) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(SYSTEM_THEME);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
}
