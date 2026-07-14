# Recording overlay: Linear-style polish + exaggerated voice response

**Date:** 2026-07-13
**Status:** design, awaiting review

## Problem

Two problems, one visible and one structural.

**The waveform barely moves when you speak.** Normal speech leaves the bars pinned
at their 3px floor — a row of flat dots that conveys nothing about whether Handy is
hearing you.

**The overlay looks unfinished.** Flat surface, no depth, a static record dot. It
should read as a polished, deliberate piece of UI.

## Root cause

Traced to `src-tauri/src/audio_toolkit/audio/visualizer.rs`. Three compounding
causes, in order of severity:

1. **The dB conversion crushes the signal.** Levels are computed as
   `20 * log10(sqrt(avg_power) / window_size)` (visualizer.rs:123). Dividing the
   magnitude by the *full* FFT window (2048 samples at 48 kHz) rather than a correct
   normalization constant bakes in roughly a −66 dB offset, so ordinary speech lands
   near the bottom of the usable range.

2. **A fixed dB window.** `DB_MIN = -55.0` / `DB_MAX = -8.0` hardcode an assumption
   about the input gain of the user's microphone. A quiet mic cannot move the bars
   no matter how loudly the user speaks. This is why hand-tuning the existing `GAIN`
   constant would not fix it in general.

3. **The response is over-damped.** `pow(0.7)` is applied twice — once in Rust
   (`CURVE_POWER`), again in the React height calculation
   (`RecordingOverlay.tsx:159`). Bars travel only 3px→18px. Frontend smoothing is
   symmetric (`prev * 0.7 + target * 0.3`), so attacks are damped exactly as hard as
   decays.

A fourth, lesser issue: the spatial smoothing loop (visualizer.rs:141-143) writes
into `buckets` in place while reading `buckets[i-1]`, so it consumes its own output —
an unintended IIR filter that smears energy across bars. This becomes moot under the
design below (the buckets go away), but it is worth naming so it is not reintroduced.

## Decisions

Settled with the user during brainstorming:

| Decision | Choice |
|---|---|
| Amplitude model | **Auto-gain** — continuously normalize against recent speech level |
| Visual scope | **Shared polish across all overlay states** (pill, working row, Live panel) |
| Waveform form | **Fluid continuous wave** (not bars) |
| Wave motion | **Scrolling history** — newest at the right edge, ~2s of trailing history |
| Envelope | **Snappy** — fast attack, ~180ms release (classic VU meter) |
| DSP placement | **Split at the clean seam** — Rust is a correct signal source; TS owns feel |

### Why the split (DSP placement)

Rust's job is to be *correct*: fix the dB math and emit one properly-calibrated
vocal-band level per frame, with no gain constants and no opinion about feel. The
frontend owns everything *perceptual*: auto-gain, envelope, history, rendering.

This puts every knob that governs "does this feel alive" behind Vite hot-reload,
where it can be tuned against a real voice in seconds rather than behind a
multi-minute Rust rebuild. The DSP that moves to TypeScript is trivial (two
exponential moving averages and a running peak) and stays pure and unit-testable.

## Architecture

### Data model change

The scrolling waveform does not want frequency buckets. It wants **one loudness
value per moment**, pushed into a rolling buffer. The `mic-level` payload therefore
collapses from `number[]` (16 FFT buckets, of which the UI used 9) to a single
`number`.

```
audio callback → FFT → vocal-band level (dBFS)   [Rust: correct]
              → emit "mic-level" (one f32, throttled 30 Hz)
              → auto-gain → envelope → ring buffer → SVG path   [TS: feel]
```

### Backend — `src-tauri/src/audio_toolkit/audio/visualizer.rs`

`AudioVisualiser` becomes a vocal-band level meter rather than a bucket spectrum.

- **Drop** the `buckets` constructor parameter, `bucket_ranges`, `noise_floor`, and
  the constants `DB_MIN`, `DB_MAX`, `GAIN`, `CURVE_POWER`. Auto-gain and curve
  shaping now live in TypeScript; a noise floor is part of auto-gain.
- **`feed(&mut self, samples: &[f32]) -> Option<f32>`** returns a calibrated **dBFS**
  level for the vocal band (400–4000 Hz), or `None` while the window is still
  filling. No gain, no curve, no clamping to a display range.
- **Correct the normalization.** Sum power across the bins spanning the vocal band,
  then convert to an amplitude-equivalent RMS accounting for the Hann window's
  coherent gain (0.5), rather than dividing the magnitude by `window_size`. The
  resulting value must be a true dBFS: a full-scale sine reads ≈ −3 dBFS, and halving
  the input amplitude must move the reading by ≈ −6 dB.
- Clamp the returned dBFS to a sane floor (e.g. −90) so digital silence does not
  produce `-inf`.

The exact normalization constant is left to the implementer to derive and *prove with
tests* (below) rather than prescribed here — that is precisely the step the current
code got wrong.

### Backend — plumbing

Signatures verified against the current code:

- `recorder.rs:78` — `level_cb: Option<Arc<dyn Fn(Vec<f32>) + ...>>` becomes
  `Fn(f32)`.
- `recorder.rs:119` — `with_level_callback<F>` bound becomes `F: Fn(f32) + Send + Sync + 'static`.
- `recorder.rs:718` — `if let Some(buckets) = visualizer.feed(&raw)` becomes a single
  level; the `BUCKETS` const (recorder.rs:545) and the `buckets` argument to
  `AudioVisualiser::new` (recorder.rs:557-563) go away. The window-size selection
  logic stays as-is.
- `overlay.rs:478` — `emit_levels(app, levels: &[f32])` becomes `emit_level(app, level: f32)`.
- `managers/audio.rs:161` — call site follows.

**Two behaviors in `emit_level` must be preserved exactly** — both exist to contain
the WebKit memory growth of issue #1279:

1. The `OVERLAY_ENABLED` guard (skip emission entirely when the overlay is disabled).
2. The ~30 Hz emission throttle (`EMIT_THROTTLE_MS`).

Smooth 60fps scrolling is achieved by interpolating in the webview via
`requestAnimationFrame`, **not** by raising the IPC emission rate. Raising the event
rate would reintroduce the exact pressure #1279 is about.

### Frontend — `src/overlay/waveform.ts` (new, pure)

A dependency-free module with no DOM access, so it is directly unit-testable:

- **`AutoGain`** — tracks a slow-adapting noise floor and a fast-attack /
  slow-release speech reference, and maps an incoming dBFS to 0–1 against that span.
  - A **minimum span** (in dB) guards the denominator, so silence cannot be amplified
    into a full-scale wave. Silence must still read as flat — that is the "am I being
    heard" signal and it must not be normalized away.
  - The reference must release slowly (order of seconds) so a single loud transient
    (a cough, a door) does not shrink normal speech for the rest of the session.
- **`Envelope`** — asymmetric exponential smoothing: fast attack, ~180ms release.
  Coefficients derived from elapsed time (`dt`), not assumed frame count, so a
  dropped frame does not change the perceived response.
- **`History`** — fixed-capacity ring buffer, ~2s at 30 Hz (~64 samples).
- **`buildWavePath(samples, width, height)`** — returns an SVG path `d` string.
  Smooth (Catmull-Rom → cubic Bézier) rather than polyline, so the wave reads as
  fluid rather than faceted.

### Frontend — `src/overlay/RecordingOverlay.tsx`

- `listen<number>("mic-level")` (payload is now a scalar). Feed
  `AutoGain → Envelope → History`.
- Render the wave as an `<svg>` inside the existing `.sbase` center slot, replacing
  `.swave`. A `requestAnimationFrame` loop redraws and applies a sub-sample
  horizontal offset so the scroll is continuous at display rate between the 30 Hz
  samples.
- Remove the double `pow(0.7)` and the 3–18px height clamp entirely.
- Stop the rAF loop whenever the overlay is not visible or not in a listening state —
  no animation loop running behind a hidden overlay.

**Visual form (flag for review):** the wave is drawn **mirrored about a horizontal
centerline** — the envelope above and its reflection below — stroked, not filled.
This is the natural realization of "scrolling history" and reads as a real recording
waveform. It is a slight departure from the approved mockup, which showed a single
undulating line. The single-line variant (upper envelope only) is a one-line change
if the mirrored form is not wanted. **This is the one open visual question.**

### Frontend — `src/overlay/RecordingOverlay.css`

Polish the **shared** building blocks so all three overlay forms level up together:

- `.scard` — layered surface, hairline border, and a depth shadow, replacing the
  current flat fill.
- `.sdot` — a slow "breathing" pulse instead of a static dot.
- `.sx` (cancel) and `.sspinner` — refined to match.

**Constraint: stay theme-aware.** The overlay already derives its palette from the
theme engine (`--s-accent: var(--color-logo-primary)`, `--s-surface` from
`--color-background`). All new styling must be expressed in those tokens — **no
hardcoded hex** — so the overlay continues to recolor correctly under Tokyo Night,
Tokyo Night Day, Handy Light, and Handy Dark.

**Respect `prefers-reduced-motion`.** Under it, drop the scroll animation and the dot
pulse; the wave still changes height with the voice (the feedback is the point), it
just does not animate continuously.

## Testing

**Rust (`cargo test`)** — the calibration is the thing the current code got wrong, so
it gets pinned by tests:

- A full-scale sine reads ≈ −3 dBFS (within tolerance).
- Halving the input amplitude moves the reading by ≈ −6 dB (proves true log scaling).
- Digital silence returns the floor, not `-inf` or `NaN`.
- A tone **outside** the vocal band (e.g. 60 Hz hum, 8 kHz hiss) reads far lower than
  an in-band tone of equal amplitude (proves band-limiting works).

**TypeScript (`bun test tests/unit`)** — the pure module:

- `AutoGain`: sustained silence → output stays ~0 (never normalized up to full scale).
- `AutoGain`: a quiet input and a loud input, each sustained, both converge toward
  full range (proves mic independence — the core promise of the feature).
- `AutoGain`: a single loud transient does not suppress subsequent normal speech to
  near-zero (no pumping).
- `Envelope`: attack reaches a step input faster than release returns from it.
- `buildWavePath`: correct point count, x monotonically increasing, output symmetric
  about the centerline.

**Manual:** build, speak at normal conversational volume, confirm the wave visibly
and immediately responds; confirm silence reads flat; confirm the overlay recolors
correctly across all four themes.

## Risks

| Risk | Mitigation |
|---|---|
| Auto-gain "pumping" — a loud transient makes normal speech look small | Slow release on the speech reference (seconds); covered by a test |
| Silence amplified into visual noise | Minimum-span guard on the denominator; covered by a test |
| Reintroducing the #1279 WebKit memory growth | Keep the `OVERLAY_ENABLED` guard and the 30 Hz throttle; do all interpolation in-webview via rAF, never by raising the IPC rate |
| rAF loop running behind a hidden overlay | Explicitly stop the loop when not visible/listening |
| Hardcoded colors breaking the theme engine | All styling via existing `--s-*` / `--color-*` tokens; verify across four themes |

## Non-goals

- No new user-facing settings or toggles for the waveform.
- No changes to VAD, transcription, or the audio capture path itself.
- No change to overlay positioning or the Live panel's text/scroll behavior.
- Not preserving the 16-bucket spectrum API — nothing else consumes it.
