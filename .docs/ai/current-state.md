# Current State

Branch: `main`

## Plan

- [x] Define macOS media pause/resume behavior. Verify: user-approved design, 2026-07-16.
- [x] Review `.docs/ai/phases/media-pause-spec.md`. Verify: user-approved, 2026-07-16.
- [?] Review `.docs/ai/phases/media-pause-plan.md`. Verify: human approval before implementation.

## Done + pushed (overlay waveform, this session)

- Feature 6fd3fa3; fixes ca373b2 (path/size/headroom/floor-gate), d681074 (flicker), b86a358 (per-sample redraw — killed horizontal edge jitter), 575ee01 (fill row). Merge fdcb098 = upstream v0.9.3. origin/main == main at 575ee01.
- Tuning knobs in src/overlay/waveform.ts: HEADROOM_DB=24, GAP_MARGIN/NOISE_RISE (floor tracks room tone), GATE_LOW/HIGH_DB=3/9, SNAP_THRESHOLD=0.12/GLIDE_MS=260 (flicker damp). User-confirmed good.
- Optional follow-up if raised: shorten history window (historyLengthFor / PX_PER_SAMPLE) so a pause shows a shorter flat tail.

## Blockers

- media-pause: awaiting plan review.

## Open questions

- None.
