# Handy — Custom Start/Stop Sounds (Design)

**Status:** Implemented on `feat/custom-start-stop-sounds` (ultracode: understand → implement → adversarial review → fix). Static/unit verification green (cargo check + 5 unit tests, tsc, ESLint, Prettier, `check:translations` 20/20). Live end-to-end (hearing sounds, drag-drop, picker) still needs a `bun run tauri dev` run on a real machine — this environment can't launch the GUI/audio. Two review findings fixed: atomic temp-then-rename file replace (no destroy-on-failed-copy), and full 20-locale i18n key parity.
**Date:** 2026-07-07
**Branch:** `feat/custom-start-stop-sounds` (fork `TaylorFinklea/Handy`, `upstream` = `cjpais/handy`)
**Feature:** Let users set their own audio file for the transcription **start** and **stop** sounds, with each slot chosen fully independently (Marimba / Pop / Custom).

---

## 1. Context / current state

Handy is a Tauri v2 app (Rust backend + React/TS frontend) that already plays a start sound when
recording begins and a stop sound when it ends. Relevant code:

- `src-tauri/src/audio_feedback.rs` — resolves + plays the sound via `rodio`, honoring `audio_feedback`
  on/off, `audio_feedback_volume`, and `selected_output_device`.
- `src-tauri/src/actions.rs` — the transcription lifecycle. Fires `play_feedback_sound_blocking(Start)`
  on record-begin (~522, ~546) and `play_feedback_sound(Stop)` on record-end (~621).
  **These trigger points already work and will NOT be modified.**
- `src-tauri/src/settings.rs` — `SoundTheme { Marimba, Pop, Custom }`; single `sound_theme` field.
  Built-in themes load `resources/{theme}_{start,stop}.wav`; `Custom` loads `custom_{start,stop}.wav`
  from AppData.
- `src/components/settings/SoundPicker.tsx` — one dropdown; shows "Custom" only if both custom files
  already exist.
- `src-tauri/src/commands/audio.rs` — `check_custom_sounds` reports whether the two files exist.

**The gap:** nothing in the app ever _writes_ the custom sound files. Playback is fully built, but there
is no import path — a user would have to hand-place files in a hidden AppData folder. This feature builds
that missing import/management path, and makes the two slots independent.

**Confirmed available:** `tauri-plugin-dialog ~2.6` (native picker) + `@tauri-apps/api ^2.10`
(webview drag-drop event) + `tauri-plugin-fs ~2.4.4`, all already dependencies. `dialog:default` +
`fs:read-files` in `src-tauri/capabilities/`. Tauri v2 window drag-drop is on by default (windows are
built in Rust; verify the builder does not disable it). Commands register in `collect_commands!`
(`lib.rs:534`); `src/bindings.ts` regenerates from specta on debug builds.

---

## 2. Requirements

- Each slot (**start**, **stop**) independently selectable as **Marimba**, **Pop**, or **Custom**
  (e.g. start = Marimba built-in, stop = Custom file, or start = Pop, stop = Marimba).
- Import a custom file per slot via **native file picker** _and_ **drag-and-drop** onto the slot.
- Accepted formats: **WAV, MP3, FLAC, OGG**, copied as-is (extension preserved; `rodio` decodes all).
- Preview a slot's current sound; reset a slot back to a built-in theme.
- Persist across restarts; old `settings.json` files keep loading (migration).

---

## 3. Approach — B (chosen)

Each slot carries its own `SoundTheme`. The existing enum is reused **unchanged**.

```
start_sound:        SoundTheme            // Marimba | Pop | Custom   (default Marimba)
stop_sound:         SoundTheme            // Marimba | Pop | Custom   (default Marimba)
custom_start_sound: Option<String>        // stored filename w/ ext in AppData, used when start_sound == Custom
custom_stop_sound:  Option<String>
```

Resolution per slot:

- `Marimba` → `resources/marimba_{slot}.wav`
- `Pop` → `resources/pop_{slot}.wav`
- `Custom` → `AppData/{custom_{slot}_sound}` if set and the file exists; else defensively fall back to
  `resources/marimba_{slot}.wav`.

The enum drives _what plays_; the `Option<String>` stores the imported filename (needed because we accept
several extensions, not just `.wav`). The two are kept coherent by the commands (§4.3).

**Why B over A:** the user wants each slot independently choosable among the built-in themes too — not just
"one shared theme + optional overrides." B also turns out to be _less_ churn: `SoundTheme` (incl. its
`Custom` variant) is kept as-is; we only split the single `sound_theme` field into `start_sound` +
`stop_sound` and add the two filename fields.

---

## 4. Detailed design

### 4.1 Settings (`src-tauri/src/settings.rs`)

- Keep `SoundTheme { Marimba, Pop, Custom }` unchanged.
- Replace the single `sound_theme` field with `start_sound: SoundTheme` + `stop_sound: SoundTheme`
  (both `#[serde(default = "default_sound_theme")]` → Marimba).
- Add `custom_start_sound: Option<String>` + `custom_stop_sound: Option<String>` (`#[serde(default)]`).
- **Migration on load** (in the settings load path): if the new slot fields are absent but a legacy
  `sound_theme` value is present, set _both_ `start_sound` and `stop_sound` to it. If legacy
  `custom_start.wav` / `custom_stop.wav` exist in AppData and the filename fields are `None`, adopt them.
  Keeps old configs and any hand-placed files working.

### 4.2 Resolution (`src-tauri/src/audio_feedback.rs`)

- Rewrite `get_sound_path` / `get_sound_base_dir` to take the _per-slot_ `SoundTheme` and, for `Custom`,
  use `custom_{slot}_sound` from AppData with an existence check (set-but-missing → theme fallback).
- `play_feedback_sound`, `play_feedback_sound_blocking`, `play_test_sound` signatures unchanged; they read
  the slot's source from settings.

### 4.3 Backend commands (`src-tauri/src/commands/audio.rs`, registered in `lib.rs`)

- `set_custom_sound(app, sound_type: String, source_path: String) -> Result<String, String>`:
  1. Map `sound_type` → slot; reject otherwise.
  2. Validate `source_path`: extension ∈ {wav,mp3,flac,ogg}; file exists; size ≤ ~5 MB.
  3. Decode probe with `rodio` — reject unplayable files with a friendly message.
  4. Delete any existing `custom_{slot}.*` (a prior import may have a different extension).
  5. Copy into AppData as `custom_{slot}.{ext}`.
  6. Set `{slot}_sound = Custom` **and** `custom_{slot}_sound = "custom_{slot}.{ext}"`; persist.
  7. Return the stored filename.
- `clear_custom_sound(app, sound_type: String) -> Result<(), String>`: delete the file (best-effort), set
  `custom_{slot}_sound = None` and `{slot}_sound = Marimba`; persist.
- Retire `check_custom_sounds` — the frontend reads slot source + filename directly from settings.

### 4.4 Frontend (`src/components/settings/SoundPicker.tsx`, `src/stores/settingsStore.ts`)

Replace the single dropdown with two independent slot rows:

```
Sound
  Start sound:  [ Marimba ▼ ]                                   ▶
  Stop sound:   [ Custom  ▼ ]   my-bloop.mp3   [ Choose file… ] ▶  ✕      ⇦ drop a file here
```

- Each row: a dropdown (Marimba / Pop / Custom). Selecting **Marimba/Pop** just updates `{slot}_sound`.
  Selecting **Custom** with no stored file opens the picker immediately; with a stored file, reuses it.
  If the picker is cancelled and no file is stored for that slot, the dropdown reverts to its previous value.
- **File picker:** `@tauri-apps/plugin-dialog` `open({ filters: [{ name: "Audio",
extensions: ["wav","mp3","flac","ogg"] }] })` → `bindings.setCustomSound(slot, path)`.
- **Drag-and-drop:** use Tauri v2's webview drag-drop event (`getCurrentWebview().onDragDropEvent`), which
  yields **absolute file paths**, and route the drop to the slot under the cursor → `setCustomSound`.
  ⚠️ Gotcha: HTML5 `ondrop` does _not_ give real filesystem paths in Tauri — the native event is required.
- Row shows the stored filename (or the theme name); `✕` (reset) shows only when the slot is `Custom` →
  `bindings.clearCustomSound(slot)`. Preview ▶ reuses `play_test_sound(slot)`.
- Store: add `setCustomSound(type, path)` / `clearCustomSound(type)`; drop the `customSounds` bool pair.
- Regenerate `src/bindings.ts` (debug build) after adding the two commands.

### 4.5 i18n

Add English keys under `settings.sound.*` for the new labels (start sound, stop sound, choose file, reset,
drop hint). Other locales fall back to English until translated.

---

## 5. Testing

- **Rust unit tests** on the resolver: each slot × {Marimba, Pop, Custom-present, Custom-missing} → correct
  path (Custom-missing → Marimba fallback). Migration: legacy `sound_theme` → both slots.
- **Manual:** set start via picker + stop via drag-drop; preview each; run a real transcription to hear
  start+stop live; set start=Pop / stop=Custom; reset a slot; restart to confirm persistence; feed a bogus
  file (wrong ext / corrupt) → friendly error, no crash.

---

## 6. Out of scope (v1)

- Transcoding to a canonical format (files stored/played in their original container).
- Multiple named custom sound sets / a sound library.
- Per-profile or per-shortcut sounds.
- New built-in themes beyond Marimba / Pop.

---

## 7. Decisions locked

- Data model: **Approach B** (per-slot `SoundTheme` + per-slot custom filename).
- Formats: **WAV / MP3 / FLAC / OGG**, copied as-is.
- Import: **file picker + drag-and-drop**.
- Repo: **gh fork → `~/git/handy`**, work on `feat/custom-start-stop-sounds`.
