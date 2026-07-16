# macOS Media Pause While Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in macOS setting that pauses the active system media session after recording starts and resumes only the session Handy paused when capture ends.

**Architecture:** A runtime-loaded native MediaRemote bridge exposes a deliberately small C ABI to Rust. A Rust controller owns a one-use media lease and is the only code that knows whether Handy paused a session; recording actions acquire the lease after microphone capture succeeds and release it as soon as capture ends. Non-macOS builds use the same controller surface with a no-op bridge.

**Tech Stack:** Rust/Tauri 2, native macOS bridge compiled by `src-tauri/build.rs`, private `MediaRemote.framework`, React/TypeScript, Zustand, i18next, Rust unit tests.

## Global Constraints

- macOS only; hide the setting on Windows and Linux.
- Default disabled; existing settings must remain disabled after upgrade.
- Runtime-load `MediaRemote.framework`; do not link the private framework at build time.
- Pause only after `AudioRecordingManager::try_start_recording` succeeds.
- Resume only the same session Handy paused, only while it remains paused, and never by sending a toggle command.
- Framework/session/command failures must be debug-logged and must not interrupt recording.
- Keep the existing unrelated overlay working-tree changes out of every commit.

---

### Task 1: Add the platform media controller and its native bridge

**Files:**
- Create: `src-tauri/src/media_control.rs`
- Create: `src-tauri/swift/media_remote.swift`
- Create: `src-tauri/swift/media_remote_bridge.h`
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` only if the bridge implementation needs a macOS-only Rust dependency

**Interfaces:**
- Consumes: `MediaRemote.framework` symbols discovered at runtime, never through Cargo linker flags.
- Produces: `MediaPauseController`, managed from `initialize_core_logic`, with `pause_if_playing()` and `resume_if_owned()` lifecycle operations.
- Produces: an opaque, one-use native lease; Rust must not interpret private framework objects or IDs.

- [ ] **Step 1: Add the module declaration and write controller tests with a fake native backend**

Declare `mod media_control;` in `lib.rs`, then create pure Rust tests in `media_control.rs` around an injected backend that prove this matrix:

```rust
assert!(controller.pause_if_playing().is_ok());
assert_eq!(fake.pause_calls(), 1);

controller.resume_if_owned();
assert_eq!(fake.resume_calls(), 1);

assert!(already_paused_controller.pause_if_playing().is_ok());
already_paused_controller.resume_if_owned();
assert_eq!(already_paused_fake.resume_calls(), 0);
```

Include cases for unavailable framework, command failure, duplicate pause attempts, and a changed active-session identity. Each failure must leave the controller without a resume lease.

- [ ] **Step 2: Run the focused controller test before implementation**

Run: `cargo test media_control --lib` from `src-tauri`.

Expected: compilation failure because the declared module's tests reference controller types that do not yet exist.

- [ ] **Step 3: Implement the Rust controller and a non-macOS no-op backend**

Define the controller around this stable boundary; the concrete private-framework details stay inside the native bridge:

```rust
trait MediaSessionBackend {
    fn pause_active_playing_session(&self) -> Result<Option<MediaLease>, MediaControlError>;
    fn resume_if_same_session_is_paused(&self, lease: MediaLease) -> Result<(), MediaControlError>;
}
```

Use a mutex-protected optional lease. `pause_if_playing()` must be idempotent while a lease exists; `resume_if_owned()` must take and clear the lease before calling the backend, so a retry or concurrent cancellation cannot resume twice. Log backend errors at debug level and return success to the recording caller.

- [ ] **Step 4: Implement the runtime-loaded macOS bridge**

Mirror the existing Apple Intelligence bridge pattern: add a separate Swift source/header pair and a macOS-all-architectures build step in `build.rs` that compiles a small static bridge library. The Swift bridge must use `dlopen`/`dlsym` for `MediaRemote.framework`, query the active player’s playback state, issue an explicit pause command, and retain only an opaque identity needed for the later resume check. It must return a no-lease result for missing symbols, a non-playing session, timeouts, or command failure.

Before declaring private C function types, inspect the installed SDK’s `MediaRemote.tbd`; use its exported `MRMediaRemoteGetNowPlayingApplicationPlaybackState`, active-player identity, and explicit command symbols. Keep their declarations in the native bridge rather than exposing them to Rust. Add a bounded callback wait so an unavailable media daemon cannot delay recording indefinitely.

- [ ] **Step 5: Register the controller at application initialization**

Manage the controller alongside the existing audio/model/transcription/history managers in `initialize_core_logic`. Ensure the headless initialization branch also registers it, so all `AppHandle` paths have the same managed state.

- [ ] **Step 6: Run the focused backend/controller tests**

Run: `cargo test media_control --lib` from `src-tauri`.

Expected: PASS for playing, already-paused, unavailable, failed-command, duplicate, and session-mismatch cases.

- [ ] **Step 7: Commit the controller layer**

```bash
git add src-tauri/src/media_control.rs src-tauri/swift/media_remote.swift src-tauri/swift/media_remote_bridge.h src-tauri/build.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add macOS media pause controller"
```

### Task 2: Persist and expose the opt-in setting

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/shortcut/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/bindings.ts`
- Modify: `src/stores/settingsStore.ts`
- Create: `src/components/settings/PauseMediaWhileRecording.tsx`
- Modify: `src/components/settings/general/GeneralSettings.tsx`
- Modify: `src/i18n/locales/*/translation.json`

**Interfaces:**
- Consumes: `AppSettings`, the existing `change_mute_while_recording_setting` command/store/component pattern, and Tauri Specta bindings.
- Produces: `pause_media_while_recording: boolean` and `change_pause_media_while_recording_setting(enabled: bool)`.

- [ ] **Step 1: Write the settings-default test**

Extend `settings::tests::empty_store_parses_with_defaults` to assert:

```rust
assert!(!settings.pause_media_while_recording);
```

Add a stored-settings fixture assertion that an absent key loads as `false` without triggering an unrelated migration.

- [ ] **Step 2: Run the focused settings test before implementation**

Run: `cargo test empty_store_parses_with_defaults --lib` from `src-tauri`.

Expected: compilation failure because `pause_media_while_recording` does not exist.

- [ ] **Step 3: Add the persisted backend setting and command**

Add the boolean to `AppSettings` with a serde default and initialize it to `false` in `get_default_settings`. Follow the existing boolean-setting command shape in `shortcut/mod.rs`, register it in `collect_commands!` in `lib.rs`, and regenerate or update `src/bindings.ts` through the existing Specta export path.

- [ ] **Step 4: Add the macOS-only Settings control**

Create `PauseMediaWhileRecording.tsx` by mirroring `MuteWhileRecording.tsx`, backed by the typed Zustand setting updater. Render it in the Sound group only when `@tauri-apps/plugin-os` reports macOS. Add label/description keys to English and every discovered locale JSON; use the repository translation checker rather than relying on fallback English.

- [ ] **Step 5: Run settings, translation, and frontend checks**

Run: `cargo test empty_store_parses_with_defaults --lib` from `src-tauri`.

Expected: PASS.

Run: `bun run check:translations`.

Expected: all locales pass with no missing or extra keys.

Run: `bun run build`.

Expected: TypeScript and Vite production build complete successfully.

- [ ] **Step 6: Commit the setting and Settings UI**

```bash
git add src-tauri/src/settings.rs src-tauri/src/shortcut/mod.rs src-tauri/src/lib.rs src/bindings.ts src/stores/settingsStore.ts src/components/settings/PauseMediaWhileRecording.tsx src/components/settings/general/GeneralSettings.tsx src/i18n/locales
git commit -m "feat: add media pause recording setting"
```

### Task 3: Connect media leasing to recording and cancellation boundaries

**Files:**
- Modify: `src-tauri/src/actions.rs`
- Modify: `src-tauri/src/utils.rs`
- Modify: `src-tauri/src/media_control.rs`
- Modify: `src-tauri/src/actions.rs` tests
- Modify: `.docs/ai/current-state.md`
- Modify: `.docs/ai/roadmap.md`
- Create: `.docs/ai/phases/media-pause-report.md`

**Interfaces:**
- Consumes: `MediaPauseController` from Tauri state and `pause_media_while_recording` from loaded settings.
- Produces: one media lease per successful recording, released as soon as capture finishes or cancellation closes capture.
- Produces: a private action-level `PauseOutcome` test seam with `Skipped` and `PausedOrNoop` cases; it must not expose private-media details to the rest of `actions.rs`.

- [ ] **Step 1: Write recording-lifecycle tests around the controller boundary**

Extract only the small decision helper needed by `TranscribeAction` so tests can assert these outcomes without opening an audio device:

```rust
assert_eq!(pause_after_capture(false, &controller), PauseOutcome::Skipped);
assert_eq!(pause_after_capture(true, &controller), PauseOutcome::PausedOrNoop);
release_after_capture(&controller);
```

Cover start failure (no pause), normal stop (one resume), cancellation before asynchronous stop completes (one resume), and a later stop after cancellation (still one resume).

- [ ] **Step 2: Run the focused lifecycle test before wiring actions**

Run: `cargo test media_pause --lib` from `src-tauri`.

Expected: failure until the helper and action integration exist.

- [ ] **Step 3: Pause only after successful capture**

In both always-on and on-demand branches of `TranscribeAction::start`, call the controller only after `try_start_recording` returns `Ok(())` and only if the loaded setting is true. Do not delay model kickoff, overlay display, microphone opening, or audio-feedback scheduling before capture has succeeded.

- [ ] **Step 4: Resume at every capture-ending boundary**

In `TranscribeAction::stop`, release the controller lease immediately after `stop_recording` returns, before WAV persistence and transcription work. In `utils::cancel_current_operation`, release it immediately after cancelling the audio manager. Rely on the controller’s take-before-resume behavior to make the asynchronous stop path harmless after a cancellation.

- [ ] **Step 5: Run focused Rust lifecycle tests**

Run: `cargo test media_pause --lib` from `src-tauri`.

Expected: PASS for start, normal stop, cancellation, and duplicate-release cases.

Run: `cargo test --lib` from `src-tauri`.

Expected: all Rust library tests pass.

- [ ] **Step 6: Run full static verification and manual macOS checks**

Run: `bun run build`.

Expected: TypeScript and Vite production build complete successfully.

Run: `bun run check:translations`.

Expected: all locale schemas pass.

Manual verification: enable the setting; start/stop a recording while Apple Music plays; repeat with one Control Center-compatible browser/player; confirm initially paused media stays paused; cancel an active recording; confirm switching active player during capture does not resume the new player.

- [ ] **Step 7: Update handoff state and commit the lifecycle integration**

Mark the roadmap item complete, clear the current plan, and write `media-pause-report.md` with the manual verification result or a clearly named human-verification pending item. Commit only the media-pause changes and docs:

```bash
git add src-tauri/src/actions.rs src-tauri/src/utils.rs src-tauri/src/media_control.rs .docs/ai
git commit -m "feat: pause macOS media while recording"
```
