# Recording overlay: Linear-style polish + exaggerated voice response

**Date:** 2026-07-13
**Status:** design, awaiting review
**Revision:** v2 — corrected after adversarial review (GLM 5.2) and numerical verification.
See "Review corrections" at the end for what changed and why.

## Problem

Two problems, one visible and one structural.

**The waveform barely moves when you speak.** Normal speech leaves the bars pinned at
their 3px floor — a row of flat dots that conveys nothing about whether Handy is
hearing you.

**The overlay looks unfinished.** Flat surface, no depth, a static record dot.

## Root cause

Traced to `src-tauri/src/audio_toolkit/audio/visualizer.rs` and verified by simulating
the exact code path against synthetic speech-like signals.

**1. (Dominant) The fixed dB window silently clamps real speech to zero.**
`DB_MIN = -55.0` / `DB_MAX = -8.0` (visualizer.rs:4-5) are calibrated as if for a
_tone-like_, energy-concentrated signal. Real speech is **broadband**: its energy is
spread across many FFT bins, so each bucket's _average_ power lands far lower than a
tone of the same amplitude would. Measured, through the current formula:

| Input                    | Per-bucket dB | Resulting bar heights (floor 3px, max 18px) |
| ------------------------ | ------------- | ------------------------------------------- |
| Loud speech (rms 0.2)    | −56…−49       | 3–9px — never exceeds half height           |
| Normal speech (rms 0.05) | −68…−60       | **all 9 bars at the 3px floor**             |
| Quiet speech (rms 0.01)  | −83…−76       | all at floor                                |

Normal speech falls **below `DB_MIN`**, is clamped to 0, and renders as the flat dots
in the bug report. This is the cause; everything else is secondary. It is also
inherently mic-dependent — no amount of retuning `GAIN` fixes it for every input
device, which is why auto-gain (below) is the structural answer rather than a bigger
constant.

**2. (Secondary) The dB conversion carries a calibration offset.**
`20 * log10(sqrt(avg_power) / window_size)` (visualizer.rs:123) divides magnitude by
`window_size` rather than the correct window-gain normalization. Measured error:
**≈ −9 dB** for a 1-bin bucket, **≈ −17 dB** for a 10-bin bucket. Real, worth fixing,
but roughly an order of magnitude smaller than cause #1.

_(An earlier draft of this spec claimed a "−66 dB offset". That was wrong: 20·log10(2048)
is the offset of dividing by N versus dividing by 1, but a correct normalization also
divides by ~N, so only the delta is error.)_

**3. (Secondary) The response is over-damped — but not where it looks.**
The real damping is the **symmetric** smoothing `prev * 0.7 + target * 0.3`
(RecordingOverlay.tsx:91), which slows attacks exactly as much as decays, plus only
15px of travel (3→18px). The `pow(0.7)` applied twice (visualizer.rs:137 and
RecordingOverlay.tsx:159) is a gamma **expansion**, not a compression — it _lifts_
small values (`0.1^0.7 = 0.20`). It flattens contrast at the top of the range; it is
not what pins the bars to the floor.

**4. (Latent bug) The spatial smoothing loop consumes its own output.**
visualizer.rs:141-143 writes into `buckets` in place while reading `buckets[i-1]` — an
unintended IIR that smears energy across bars. Moot under this design (the buckets go
away), but named so it is not reintroduced.

**5. (Pre-existing bug, found during review) Levels are emitted even when not recording.**
`visualizer.feed(&raw)` (recorder.rs:718) is **not** inside any `if recording` guard,
and `emit_levels` (overlay.rs:478) gates only on the `OVERLAY_ENABLED` _setting_ — not
on whether the overlay is actually shown. In always-on microphone mode with the overlay
enabled, `mic-level` events therefore stream into a **hidden** overlay webview at ~23 Hz
all day. This is very plausibly a live driver of the WebKit memory growth in issue
**#1279**, and it must be fixed here — because this design makes each event's handler
_more_ expensive, which would otherwise make #1279 worse.

## Decisions

| Decision        | Choice                                                                |
| --------------- | --------------------------------------------------------------------- |
| Amplitude model | **Auto-gain** — normalize against the user's recent speech level      |
| Visual scope    | **Shared polish across all overlay states**                           |
| Waveform form   | **Fluid continuous wave** (not bars)                                  |
| Wave motion     | **Scrolling history** — newest at the leading edge, ~2s trail         |
| Envelope        | **Snappy** — fast attack, ~180ms release                              |
| DSP placement   | **Split** — Rust is a correct signal source; TypeScript owns the feel |

### Why the split

Rust's job is to be _correct_: emit one properly-calibrated vocal-band level per frame,
with no gain constants and no opinion about feel. The frontend owns everything
_perceptual_: auto-gain, envelope, history, rendering. This puts every knob governing
"does this feel alive" behind Vite hot-reload — tunable against a real voice in seconds
instead of a multi-minute Rust rebuild — while the part that must be _correct_ stays in
Rust with unit tests.

## Architecture

### Data model change

The scrolling waveform does not want frequency buckets; it wants **one loudness value
per moment**. The `mic-level` payload collapses from `number[]` (16 buckets, 9 used) to
a single `number`. Verified: `RecordingOverlay.tsx:85` is the **only** consumer, so this
is safe.

### Backend — replace the FFT with a band-pass + RMS

**Drop the FFT for this path entirely.** A 2048-point FFT is only earned by _spectral_
information, and this design throws the spectrum away. For a single vocal-band scalar, a
**4-pole IIR band-pass (400–4000 Hz) followed by RMS over the frame** is roughly an order
of magnitude cheaper, perceptually equivalent, and — decisively — **trivially calibrated**:
time-domain RMS needs no window-gain correction at all, which is exactly the step the
current code got wrong.

`AudioVisualiser` becomes a band-limited level meter:

- Constructor drops `buckets`, `freq_min`/`freq_max` become the band-pass design
  parameters. `bucket_ranges`, `noise_floor`, `DB_MIN`, `DB_MAX`, `GAIN`, `CURVE_POWER`
  all go away — auto-gain and curve shaping now live in TypeScript.
- **`feed(&mut self, samples: &[f32]) -> Option<f32>`** returns a calibrated **dBFS**
  level, or `None` while the frame is still filling. No gain, no curve, no display clamp.
- `20 * log10(rms)`, clamped to a −90 dBFS floor so digital silence never yields
  `-inf`/`NaN`.
- IIR filter state must be cleared in `reset()` (called on `Cmd::Start`, recorder.rs:619)
  so one recording's tail cannot bleed into the next.

**If the FFT is kept anyway** (e.g. a spectral feature is anticipated), the band-summed
RMS normalization is `RMS = sqrt(Σ|X[k]|²) · √2 / (N · √g₂)` where `g₂ = (1/N)Σw[n]² = 3/8`
for Hann — the window **power gain**, _not_ the coherent gain (0.5). Verified numerically:
this yields exactly −3.01 dBFS for a full-scale sine and −23.01 at −20 dBFS (0.00 dB error).
Using coherent gain here instead yields −4.26 dBFS and is wrong.

### Backend — plumbing (signatures verified against current code)

- `recorder.rs:78` — `level_cb: Option<Arc<dyn Fn(Vec<f32>) + ...>>` → `Fn(f32)`.
- `recorder.rs:119` — `with_level_callback<F>` bound → `F: Fn(f32) + Send + Sync + 'static`.
- `recorder.rs:718` — single level instead of buckets; `BUCKETS` (recorder.rs:545) and the
  `buckets` arg to `AudioVisualiser::new` (recorder.rs:557-563) go away.
- `overlay.rs:478` — `emit_levels(app, &[f32])` → `emit_level(app, f32)`.
- `managers/audio.rs:161` — call site follows.

**Three behaviors must hold in the emission path** — the first two exist today for #1279,
the third is the fix for root cause #5:

1. Keep the `OVERLAY_ENABLED` guard.
2. Keep the emission throttle. **Note:** `EMIT_THROTTLE_MS = 33` (30 Hz) is largely inert
   — a 2048-sample window at 48 kHz yields a level only every ~42.7 ms (**~23 Hz**), below
   the throttle. Sizing decisions must use the _measured_ rate, not 30 Hz.
3. **New: emit only while recording AND the overlay is actually shown.** Gate on a
   recording/visibility flag, not just the setting. Without this, a hidden overlay is fed
   ~23 Hz of events all day in always-on mode.

Smooth scrolling is achieved by interpolating in the webview, **never** by raising the IPC
rate — that would reintroduce exactly the pressure #1279 is about.

### Frontend — `src/overlay/waveform.ts` (new, pure, no DOM)

- **`AutoGain`** — maps incoming dBFS to 0–1 against a `[noise_floor, speech_ref]` span.
  - **`speech_ref` is a high percentile (P90) of dBFS over a ~2s sliding window**, _not_ a
    fast-attack/slow-release running peak. A running peak is pinned by a single transient
    (a cough, a door), and the only mitigation — slow release — is the very thing that then
    keeps normal speech small for seconds afterward. A percentile rejects transients
    _without_ that hangover and still tracks genuine level changes.
  - **Fed VAD-gated audio where available.** The level is computed pre-VAD
    (recorder.rs:718), so a raw `speech_ref` is really a _loudest-sound_ reference — in a
    noisy room (fan, AC) it adapts to the noise and speech never lifts off, reproducing the
    exact bug we are fixing. Where the active VAD policy marks frames, only speech frames
    update `speech_ref`. Under `VadPolicy::Disabled`, fall back to raw and accept the
    documented caveat that the wave then shows _input_ level, noise included.
  - A **minimum span** guards the denominator so silence is never normalized up to full
    scale. Silence must read flat — that is the "am I being heard" signal.
  - **Cold start:** initialize `speech_ref = -60 dBFS`, `noise_floor = -90 dBFS`, so the
    first words read near full scale and the gain adapts _down_. The reverse initialization
    would make the overlay dead exactly when the user starts speaking — its worst moment.
- **`Envelope`** — asymmetric exponential smoothing: fast attack, ~180ms release.
  Coefficients derived from elapsed `dt`, not an assumed frame count.
- **`History`** — ring buffer. **Sized by rendered width at a constant ~2px/sample**, not by
  a fixed time window: the pill (~172px) and the Live panel (~392px) differ ~2.3× in width,
  so a fixed sample count would render at visibly different densities. Constant px/sample
  keeps the wave's texture identical across states; the panel simply shows a longer trail.
- **`buildWavePath(samples, width, height)`** — SVG path `d`, Catmull-Rom → cubic Bézier so
  the wave reads fluid rather than faceted.

### Frontend — `src/overlay/RecordingOverlay.tsx`

- `listen<number>("mic-level")`. **When `!isVisible`, the handler early-returns before any
  AutoGain/Envelope/History work** — not merely skipping the render. (Belt-and-braces with
  the backend gate above; the listener is registered unconditionally.)
- Render an `<svg>` in the existing `.sbase` center slot, replacing `.swave`. Remove the
  double `pow(0.7)` and the 3–18px clamp.
- **rAF targets ~30 Hz, not 60.** Input arrives at ~23 Hz, so 60 Hz buys nothing but
  compositing cost: the overlay is a transparent always-on-top panel, so every frame forces
  the compositor to re-blend the desktop behind it — a real battery cost during long
  dictation on an integrated GPU. The sub-sample interpolation is for scroll smoothness,
  not for amplitude.
- **Stop the rAF loop** whenever not visible or not in a listening state.
- **Reset `AutoGain`/`Envelope`/`History` on each `show-overlay`**, so a new recording never
  opens with the previous one's tail.
- **RTL:** scroll direction follows text direction — newest at the **left** in RTL — so the
  wave reads with the language, not against it. The overlay already flips `dir`.

### Frontend — `src/overlay/RecordingOverlay.css`

Polish the **shared** blocks so all three forms level up together: `.scard` (layered
surface, hairline border, depth shadow), `.sdot` (slow breathing pulse), `.sx` and
`.sspinner` refined to match.

**Stay theme-aware.** The overlay derives its palette from the theme engine
(`--s-accent: var(--color-logo-primary)`, `--s-surface` from `--color-background`). All new
styling must use those tokens — **no hardcoded hex** — so it recolors correctly under Tokyo
Night, Tokyo Night Day, Handy Light, and Handy Dark.

**`prefers-reduced-motion`:** drop rAF **entirely** and update the path directly on each
`mic-level` event (~23 Hz); no continuous loop, no dot pulse. The wave still responds to the
voice — that is the feature — it just does not animate on its own.

## Testing

Every test below must be able to **fail**. Named because the previous draft's tests could not.

**Rust (`cargo test`)**

- **Two-point absolute calibration** (pins slope _and_ offset — a single point or a ratio
  test pins only one): full-scale in-band sine → **−3.01 ± 0.5 dBFS**; a −20 dBFS sine →
  **−23.01 ± 0.5 dBFS**.
  _(A "halving the amplitude moves it −6 dB" test is near-tautological — any `20·log10`
  mapping satisfies it by construction. It validates the slope, never the offset, which is
  the part the current code gets wrong.)_
- **Rolloff sharpness, near the edge:** a 4.2 kHz tone (just above the 4 kHz cutoff) reads
  ≥ 15 dB below an in-band tone of equal amplitude. _(60 Hz / 8 kHz pass trivially for any
  band limit and prove nothing.)_
- Digital silence returns the −90 floor, never `-inf`/`NaN`.
- `reset()` clears filter state: an impulse before reset does not affect the level after it.

**TypeScript (`bun test tests/unit`)**

- **Noisy room** (the real failure mode, untested in the previous draft): sustained −40 dBFS
  noise floor + −30 dBFS speech → speech output exceeds **0.6** of full scale.
- Mic independence: a sustained quiet input and a sustained loud input both converge toward
  full range.
- Silence is never amplified: sustained silence stays ~0.
- No pumping: a single loud transient does not suppress subsequent normal speech to near-zero.
- Cold start: the first 500ms of speech after init averages > 0.5 of full scale.
- `Envelope`: attack reaches a step input faster than release returns from it.
- `buildWavePath`: correct point count, x monotonic, symmetric about the centerline.

**Integration**

- **No `mic-level` event reaches the webview while the overlay is hidden** (guards #1279 and
  root cause #5).

**Manual:** speak at conversational volume — the wave responds visibly and immediately;
silence reads flat; the overlay recolors correctly across all four themes.

## Risks

| Risk                                                                    | Mitigation                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Auto-gain adapts to room noise, speech never lifts off                  | VAD-gate `speech_ref`; covered by the noisy-room test                     |
| Transient (cough/door) pins the gain                                    | P90 percentile estimator, not a running peak                              |
| Dead overlay for the first second — worst possible moment               | Cold-start init biases toward full scale; covered by a test               |
| Worsening #1279 with a heavier per-event handler                        | Gate emission on recording+visible; frontend early-return when hidden     |
| Compositing/battery cost of a transparent always-on-top panel animating | rAF at ~30 Hz, stopped when hidden; dropped entirely under reduced-motion |
| Hardcoded colors breaking the theme engine                              | Theme tokens only; verify across four themes                              |

## Non-goals

- No new user-facing settings for the waveform.
- No changes to VAD behavior, transcription, or the capture path (we only _read_ VAD state).
- No change to overlay positioning or the Live panel's text/scroll behavior.
- Not preserving the 16-bucket spectrum API — nothing consumes it. _(One-way door: a future
  spectral feature would need a Rust change to re-expose bins. Accepted.)_

## Open question

**The wave is drawn mirrored about a horizontal centerline** (envelope plus its reflection,
stroked, not filled) — the natural reading of "scrolling history" and closest to a real
recording waveform. The approved mockup showed a **single undulating line**. The single-line
variant (upper envelope only) is a one-line change. **Confirm which.**

## Review corrections (v1 → v2)

Adversarially reviewed by GLM 5.2 (`opencode-go/glm-5.2`), then every claim verified against
the code or by numerical simulation. Changes:

1. **Root cause re-ranked and re-derived.** v1 claimed a "−66 dB crush" from the dB math and
   ranked it #1. That figure was wrong (it is `20·log10(N)`, the offset versus dividing by 1,
   but a correct normalization also divides by ~N). Real offset: ~9–17 dB. The _dominant_
   cause is the fixed `DB_MIN`/`DB_MAX` window clamping broadband speech to zero — confirmed
   by simulation.
2. **Normalization corrected.** v1 said "coherent gain (0.5)" while also targeting −3.01 dBFS
   — mutually incompatible (coherent gain yields −4.26). The correct factor for a band-summed
   RMS is the window **power gain** √(3/8). Verified: 0.00 dB error.
3. **FFT dropped** in favor of band-pass + RMS — ~10× cheaper for a scalar output, and it
   removes the window-gain normalization as a source of error entirely.
4. **AutoGain estimator changed** from a running peak to a P90 percentile, and **VAD-gated** —
   v1 would have adapted to room noise and reproduced the very bug it fixes.
5. **A live #1279 bug found:** levels are emitted to a hidden overlay all day in always-on
   mode. Now root cause #5, with an emission gate and an integration test.
6. **`pow(0.7)` framing corrected** — it is an expansion, not a compression. The real damping
   is the symmetric EMA.
7. **Tests hardened** — v1's were largely tautological (a ×2 ratio test cannot fail for any
   log mapping). Replaced with two-point absolute calibration, a near-edge rolloff test, and a
   noisy-room test.
8. **Added:** cold-start init, reset-between-recordings, RTL scroll direction, width-derived
   history sizing, rAF at 30 Hz (compositing cost), reduced-motion drops rAF entirely.
