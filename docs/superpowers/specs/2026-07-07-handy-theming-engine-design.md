# Handy — Theming Engine (Design)

**Status:** Implemented 2026-07-07 on `feat/theming-engine` (stacked on `feat/custom-start-stop-sounds`). Static/unit verification green (cargo check + 7 unit tests, tsc, ESLint, Prettier, `check:translations` 20/20, `bun test` 4/4). Reviewed (native code-reviewer: no correctness findings). Live end-to-end (seeing each theme, no-flash boot, System-follows-OS) still needs a `bun run tauri dev` run — this environment can't launch the GUI. Known follow-up: the recording **overlay** now follows the chosen theme's `--color-*` tokens, but its internal `--s-*` tuning (RecordingOverlay.css) still keys off `@media (prefers-color-scheme: dark)`; fully theming the overlay is deferred (see §6).
**Feature:** A theming engine — multiple named, user-selectable color themes with live switching and persistence — shipping **Tokyo Night as the default and flagship** (the theme the user runs daily, so it is the exemplar the others follow).

---

## 1. Context / current state

Handy uses **Tailwind v4** with CSS-based config (`@theme inline` in `src/App.css`, no JS config). App colors flow through **CSS custom properties**:

- `src/styles/theme.css` — ~7 `--color-*` tokens in `:root` (light) + a `@media (prefers-color-scheme: dark)` override.
- `src/App.css` — `@import "tailwindcss"`, `@import "./styles/theme.css"`, then `@theme inline { --color-*: var(--color-*) }` registers those tokens as Tailwind utilities (`bg-background`, `text-text`, `text-mid-gray`, `border-logo-primary`, …). Also derives `--color-log-surface`, `--scrollbar-thumb` via `color-mix`.
- `src/main.tsx:7` sets `document.documentElement.dataset.platform`; `src/lib/utils/rtl.ts` sets `dir`/`lang` — precedent for root-attribute management.

**Token usage (measured):** components overwhelmingly use the semantic tokens (`text`, `background`, `mid-gray`, `logo-primary`, with `/opacity`); raw Tailwind palette colors survive only for **semantic states** (red=error, green=success, amber=warning, blue=info) across ~15 files.

**Implication:** a theme = a set of `--color-*` values; switching = swapping which values `:root` receives. **No component rewrites.** The current `@media (prefers-color-scheme: dark)` behavior graduates into named, user-selectable themes.

**Incidental fix:** `SoundPicker.tsx` references a `primary` token that doesn't exist (only `logo-primary` does), so its drag ring is colorless — corrected here to `logo-primary`.

---

## 2. Requirements

- Multiple named themes, user-selectable in settings; live-switch (no reload); persisted.
- Ship **Tokyo Night (dark)** as default + flagship, plus Tokyo Night Day (light), Handy Light, Handy Dark, and **System** (follows OS).
- Adding a future theme is a data change (CSS block + registry entry), not architecture.
- Old `settings.json` files keep loading; no flash of the wrong theme on launch.

---

## 3. Approach — full theme picker (approved)

**Themes are pure frontend/CSS data; the backend only persists a string id.** Each theme is a `:root[data-theme="<id>"]` CSS block overriding the `--color-*` tokens (+ `color-scheme`). The chosen id is written to `<html data-theme>`; `@theme inline` and all components adapt automatically.

Rejected: (a) reskin-only (no picker; not an engine); (b) a backend `Theme` enum (every new theme becomes a Rust change; themes belong in the frontend).

---

## 4. Detailed design

### 4.1 Theme registry (`src/lib/themes.ts`, new)

```ts
type Appearance = "light" | "dark";
interface ThemeDef {
  id: string;
  label: string;
  appearance: Appearance;
}

const THEMES: ThemeDef[] = [
  { id: "tokyo-night", label: "Tokyo Night", appearance: "dark" },
  { id: "tokyo-night-day", label: "Tokyo Night Day", appearance: "light" },
  { id: "handy-light", label: "Handy Light", appearance: "light" },
  { id: "handy-dark", label: "Handy Dark", appearance: "dark" },
];
const DEFAULT_THEME = "tokyo-night";
const SYSTEM_LIGHT = "handy-light"; // "system" follows OS between this pair
const SYSTEM_DARK = "handy-dark";
```

Pure helpers: `resolveTheme(id, prefersDark) -> concreteId` ("system" → light/dark pair; unknown id → DEFAULT_THEME) and `applyTheme(id)` (sets `data-theme` + caches to `localStorage`). `resolveTheme` is DOM-free and unit-tested.

### 4.2 Theme definitions (`src/styles/themes.css`, new; `theme.css` folded into it)

One block per theme (example):

```css
:root[data-theme="tokyo-night"] {
  color-scheme: dark;
  --color-text: #c0caf5;
  --color-background: #1a1b26;
  --color-mid-gray: #565f89;
  --color-logo-primary: #7aa2f7;
  --color-background-ui: #7aa2f7;
  --color-logo-stroke: #bb9af7;
  --color-text-stroke: #1a1b26;
  --color-log-surface: #16161e;
}
```

- Existing `theme.css` `:root` light palette → `handy-light`; its dark media override → `handy-dark`.
- `color-scheme` per block makes native scrollbars/controls match the theme (not the OS).
- Remove the `@media (prefers-color-scheme: dark)` `--color-log-surface` override in `App.css`; set `--color-log-surface` explicitly per dark theme (light themes keep the `color-mix` default). Appearance is theme-driven, never OS-driven except in System mode.

**Tokyo Night palette (canonical enkia; flagship — get exact):**
| token | Tokyo Night (dark) | Tokyo Night Day (light) |
|---|---|---|
| text | `#c0caf5` | `#3760bf` |
| background | `#1a1b26` | `#e1e2e7` |
| mid-gray | `#565f89` | `#848cb5` |
| logo-primary (accent) | `#7aa2f7` | `#2e7de9` |
| background-ui | `#7aa2f7` | `#2e7de9` |
| logo-stroke | `#bb9af7` | `#9854f1` |
| text-stroke | `#1a1b26` | `#e1e2e7` |
| log-surface | `#16161e` | derived |

### 4.3 Applying the theme (`src/hooks/useTheme.ts`, new; mounted in `App.tsx`)

- Reads `getSetting("theme")`; applies `resolveTheme(id, prefersDark)` whenever it changes.
- In **System** mode, subscribes to `matchMedia("(prefers-color-scheme: dark)")`, re-applies on OS change, unsubscribes otherwise.
- **No flash:** `main.tsx` reads `localStorage["handy-theme"]` (fallback `DEFAULT_THEME`) and stamps `data-theme` **synchronously before React renders**, beside the existing `dataset.platform` line. The store stays the source of truth and writes `localStorage` on change.

### 4.4 Settings UI (`src/components/settings/ThemeSelector.tsx`, new)

- A grouped `SettingContainer` with a `Dropdown`: the 4 themes + "System". `selectedValue = getSetting("theme")`; `onSelect → updateSetting("theme", id)` → live via `useTheme`.
- Placed in a new **"Appearance"** `SettingsGroup` at the top of `GeneralSettings.tsx` (mirrors the "Sound" group; no Sidebar changes).
- Theme display names come from the registry (proper nouns, not JSX literals → satisfies the i18n ESLint rule); "System" + section title/description use `t()`.

### 4.5 Backend (`settings.rs`, `shortcut/mod.rs`, `lib.rs`)

- Add `theme: String` to `AppSettings` (`#[serde(default = "default_theme")]`); `default_theme() -> "tokyo-night"`; add to `get_default_settings`.
- `change_theme_setting(app, theme: String)` mirrors `change_start_sound_setting` (stores the string; unknown ids tolerated, resolved frontend-side).
- Register in `collect_commands!`; add `theme` → `commands.changeThemeSetting` to `settingUpdaters`; regenerate `bindings.ts` (debug build).
- **No migration.** Existing users default to **Tokyo Night** on upgrade (matches "Tokyo Night is the default").

### 4.6 i18n

New keys `settings.appearance.{title,description}` and `settings.theme.{label,description,system}` — added to **all 20 locales** (English placeholders) for the `check:translations` parity gate. Theme proper-noun names stay in the registry, untranslated.

---

## 5. Testing

- **Unit (TS):** `resolveTheme` — system+prefersDark→SYSTEM_DARK; system+light→SYSTEM_LIGHT; known id→itself; unknown→DEFAULT_THEME.
- **Rust:** default settings carry `theme == "tokyo-night"`; a settings.json without the key loads.
- **Manual:** live-switch each theme; Tokyo Night on fresh launch, no flash; System follows OS toggle live; restart persists; log viewer/scrollbars adapt; `check:translations` 20/20.

---

## 6. Out of scope (v1)

- Theming the recording **overlay** window (own entry/CSS) — follow-up.
- Tokenizing semantic **state** colors (error/success/warning) — stay Tailwind defaults; readable on all shipped themes.
- User-authored/custom themes, import/export.
- A dedicated top-level "Appearance" settings section (v1 uses a group in General).
- Per-theme swatch previews (optional later).

---

## 7. Decisions locked

- Full theme picker; explicit themes + System; existing users upgrade to Tokyo Night.
- Theme set: Tokyo Night (default/flagship), Tokyo Night Day, Handy Light, Handy Dark, System.
- Themes are string ids owned by the frontend; backend persists the string.
