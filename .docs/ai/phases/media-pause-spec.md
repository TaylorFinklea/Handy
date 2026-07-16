# macOS media pause while recording

## Goal

When enabled, Handy pauses an active macOS system media session after microphone capture has begun, then resumes only the same session that Handy paused when capture ends.

## Scope

- macOS only; setting is hidden on other platforms.
- Opt-in setting in the Sound section; default disabled.
- Use the private `MediaRemote.framework` through runtime loading.
- Support players surfaced through the macOS system media session / Control Center.

## Non-goals

- Mac App Store compatibility.
- Player-specific integrations or browser automation.
- Changing media volume, track, output device, or playback position.
- Resuming playback after transcription generation; resume is tied to capture ending.

## Recording lifecycle

1. Start microphone capture using the existing recording path.
2. Only after capture starts successfully and the setting is enabled, inspect the active media session.
3. If that session is playing and accepts pause, retain a one-use lease containing its identity and Handy-owned paused state.
4. On normal recording stop, cancellation, or start-failure cleanup, attempt resume only when a lease exists, the active session still matches it, and it remains paused.
5. Clear the lease after the resume attempt. Never send a toggle command.

## Failure behavior

- Missing framework, unavailable active session, unsupported player, query failure, command failure, or session mismatch: log at debug level and leave recording unaffected.
- A recording start failure cannot produce a lease because media pause occurs only after successful capture.
- Concurrent/repeated start-stop signals must not overwrite an active lease or resume a newer session.

## Architecture

- Isolate unsafe/private macOS interaction behind a narrow platform controller.
- Keep the recording action responsible only for acquiring and releasing the controller lease at the existing capture lifecycle boundaries.
- Provide a testable abstraction so lifecycle tests do not load the private framework.
- Compile non-macOS targets against a no-op implementation.

## Settings and migration

- Add a persisted boolean setting with a serde default of `false`.
- Expose it in General Settings’ Sound group with an i18n label and description.
- Existing settings remain unchanged and disabled after upgrade.

## Verification

- Unit tests: playing session pauses and resumes; initially paused session is untouched; failed start creates no lease; cancellation releases a lease; session mismatch does not resume; unavailable controller is a no-op.
- Build: frontend typecheck/bundle and focused Rust tests.
- Manual macOS: enable setting; verify Apple Music and one browser/player shown in Control Center pause at recording start and resume after capture; confirm already-paused media stays paused.
