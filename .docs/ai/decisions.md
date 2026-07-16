# Decisions

## 2026-07-16 — Use MediaRemote for opt-in macOS media pausing

**Context**: Handy must pause a currently playing system media session when recording starts and resume only media that Handy paused.

**Decision**: Add a macOS-only, opt-in MediaRemote integration for this non-App-Store fork.

**Alternatives considered**: A media-key toggle cannot identify playback state; public player adapters do not cover arbitrary Control Center-compatible players.

**Rationale**: MediaRemote is the only explored option that can meet the requested global pause-and-conditional-resume behavior without false toggles.
