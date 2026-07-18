// Perceptual layer for the recording overlay's waveform.
//
// The backend is deliberately opinion-free: it reports a calibrated vocal-band level in
// dBFS and nothing else. Everything that decides how that *feels* — how loud is "full
// scale", how fast the wave reacts, how much history it shows — lives here, in front of
// Vite's hot reload, so it can be tuned against a real voice in seconds.
//
// Every export is pure or self-contained (no DOM, no globals), so it is directly unit
// testable — see tests/unit/waveform.test.ts.

/** dBFS reported by the backend for digital silence. */
export const SILENCE_DBFS = -90;

// --- AutoGain ---------------------------------------------------------------------

/** A level must sit this far above the noise floor to count as speech. */
const SPEECH_MARGIN_DB = 6;
/** The noise floor only rises toward levels at least this far *below* recent speech —
 *  i.e. genuine room tone in the gaps between words. This is what lets the floor climb to
 *  meet real room noise (so the tail of speech gates to flat) without sustained speech
 *  dragging the floor up with it. */
const GAP_MARGIN_DB = 10;
/** Headroom above the user's typical (P90) speech that maps to full wave height. Without
 *  it, "full scale" is calibrated to normal speech, so the wave sits pinned near the top
 *  whenever you talk — the aggressive feel. With headroom, normal speech lands mid-wave
 *  and only a raised voice fills it, and the reference still adapts to your level. */
const HEADROOM_DB = 24;
/** Floor on the dynamic range. Guards the denominator when speech_ref and the noise floor
 *  are momentarily close (startup, near-silence) so tiny fluctuations aren't stretched to
 *  full scale. */
const MIN_SPAN_DB = 12;
/** Soft noise-gate band, in dB above the noise floor. Levels at or below `GATE_LOW_DB`
 *  above the floor render flat; the wave fades fully in by `GATE_HIGH_DB`. This calms the
 *  jittery baseline at the tail of speech without touching speech, which sits far higher. */
const GATE_LOW_DB = 3;
const GATE_HIGH_DB = 9;
/** The noise floor drops quickly toward any quieter level, and rises toward louder ones
 *  only when they are gap-level room tone (see GAP_MARGIN_DB) — moderately, so it tracks
 *  real room noise within a second or two without chasing speech. */
const NOISE_FALL = 0.25;
const NOISE_RISE = 0.05;
/** ~2s of speech history at ~30Hz, used for the percentile. */
const SPEECH_WINDOW = 64;
/** Cold-start values. speech_ref starts mid so the first words read around mid-wave (the
 *  headroom feel from the very first syllable), and the floor starts low so early speech
 *  is never gated. The floor then climbs to meet real room noise within a second. */
const INITIAL_SPEECH_REF = -40;
const INITIAL_NOISE_FLOOR = SILENCE_DBFS;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear-interpolated percentile of an unsorted sample set. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return INITIAL_SPEECH_REF;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Maps an incoming dBFS level to 0..1 against the span between the room's noise floor
 * and the user's own recent speech level — so the wave fills the same range whether the
 * user whispers into a quiet studio mic or talks over a fan on a cheap laptop.
 *
 * The speech reference is a **P90 percentile**, not a running peak. A peak is pinned by
 * a single transient (a cough, a door) and the only way to release it is a slow decay —
 * which is itself the bug, because it then keeps normal speech looking small for
 * seconds afterwards. A percentile discards the outlier outright.
 */
export class AutoGain {
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private speechRef = INITIAL_SPEECH_REF;
  private speech: number[] = [];

  /** Feed one level in dBFS; returns the normalized 0..1 amplitude. */
  push(db: number): number {
    // Track the noise floor: fall fast toward any quieter level; rise toward louder ones
    // only when they sit well below recent speech (room tone in the gaps), so sustained
    // speech never drags the floor up with it. This is what lets the floor climb from its
    // low cold-start value to real room noise, so the tail of speech reads as flat.
    if (db < this.noiseFloor) {
      this.noiseFloor += (db - this.noiseFloor) * NOISE_FALL;
    } else if (db < this.speechRef - GAP_MARGIN_DB) {
      this.noiseFloor += (db - this.noiseFloor) * NOISE_RISE;
    }

    // Only levels that are plausibly speech update the reference. Without this the
    // reference tracks whatever is loudest in the room — a fan, the AC — and in a noisy
    // room speech never lifts off the floor: exactly the bug this replaces.
    if (db > this.noiseFloor + SPEECH_MARGIN_DB) {
      this.speech.push(db);
      if (this.speech.length > SPEECH_WINDOW) this.speech.shift();
      this.speechRef = percentile(this.speech, 0.9);
    }

    // "Full height" sits a headroom margin above typical speech, not at it, so normal
    // speech reads mid-wave and only a raised voice reaches the top.
    const ceil = this.speechRef + HEADROOM_DB;
    const span = Math.max(MIN_SPAN_DB, ceil - this.noiseFloor);
    const normalized = clamp01((db - this.noiseFloor) / span);

    // Soft noise gate: fade the wave to flat as the level approaches the noise floor.
    // At the tail of speech the level drops into residual room noise, which auto-gain
    // would otherwise amplify into a jittering baseline. Speech sits well above the gate,
    // so this leaves the snappy response untouched — it only calms genuine near-silence.
    const above = db - this.noiseFloor;
    const gate = clamp01((above - GATE_LOW_DB) / (GATE_HIGH_DB - GATE_LOW_DB));
    return gate * normalized;
  }

  reset(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR;
    this.speechRef = INITIAL_SPEECH_REF;
    this.speech = [];
  }
}

// --- Envelope ---------------------------------------------------------------------

/** Fast enough to catch a syllable's onset. Applies only to *large* upward moves. */
const ATTACK_MS = 15;
/** Slow enough that the wave settles rather than snapping to zero between words. */
const RELEASE_MS = 180;
/** Moves smaller than this (in 0..1 amplitude) are treated as flicker — breath, final
 *  consonants, residual noise as the voice trails off — and heavily smoothed in both
 *  directions, so the tail glides instead of chattering. Real speech onsets clear it and
 *  keep the fast attack, so punch is preserved. */
const SNAP_THRESHOLD = 0.12;
/** Time constant for those small flicker moves — long enough to glide over the wobble. */
const GLIDE_MS = 260;

/**
 * Asymmetric smoothing: quick to rise on a real speech onset, gentle to fall, and heavily
 * damped on small flicker either way. The rise/fall asymmetry is what makes the wave read
 * as *alive*; the flicker damping is what stops the tail of a word from chattering while
 * leaving that liveliness intact.
 *
 * Coefficients derive from elapsed time, not an assumed frame count, so a dropped frame
 * changes nothing about the perceived response.
 */
export class Envelope {
  private value = 0;

  process(target: number, dtMs: number): number {
    const delta = target - this.value;
    // Small moves (flicker) glide regardless of direction; only a large upward move earns
    // the fast attack, and larger downward moves use the normal release.
    const tau =
      Math.abs(delta) < SNAP_THRESHOLD
        ? GLIDE_MS
        : delta > 0
          ? ATTACK_MS
          : RELEASE_MS;
    // Guard against a pathological dt (e.g. a backgrounded tab resuming) snapping the
    // envelope; exp() handles it correctly but clamp keeps it sane.
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tau);
    this.value += delta * alpha;
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

// --- History ----------------------------------------------------------------------

/** Horizontal density of the wave. Held constant so the pill (~172px) and the wider Live
 *  panel (~392px) render the same texture — the panel simply shows a longer trail — and
 *  not the same sample count stretched to different widths. */
export const PX_PER_SAMPLE = 2;

/** Number of samples a wave of the given pixel width should hold. */
export const historyLengthFor = (width: number) =>
  Math.max(8, Math.round(width / PX_PER_SAMPLE));

/** Fixed-capacity ring of recent amplitudes, oldest first. */
export class History {
  private samples: number[];

  constructor(private capacity: number) {
    this.samples = new Array(capacity).fill(0);
  }

  push(v: number): void {
    this.samples.push(v);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Oldest-to-newest. */
  values(): number[] {
    return this.samples;
  }

  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    const kept = this.samples.slice(-capacity);
    this.samples = new Array(Math.max(0, capacity - kept.length))
      .fill(0)
      .concat(kept);
  }

  reset(): void {
    this.samples = new Array(this.capacity).fill(0);
  }
}

// --- Path building ----------------------------------------------------------------

/** Smallest visible amplitude, so silence reads as a hairline rather than vanishing. */
const MIN_AMPLITUDE = 0.02;

/**
 * Builds a smooth SVG path for the wave, mirrored about the horizontal centerline: the
 * amplitude envelope is traced left-to-right along the top, then back along its
 * reflection, so the result reads as a recording waveform rather than a line chart.
 *
 * Catmull-Rom control points converted to cubic Béziers — a polyline through ~90 samples
 * looks faceted at this size, and the whole point of the shape is that it feels fluid.
 *
 * @param samples oldest→newest amplitudes in 0..1
 * @param rtl     when true the newest sample sits at the *left*, so the wave grows with
 *                the text direction instead of against it
 */
export function buildWavePath(
  samples: number[],
  width: number,
  height: number,
  rtl = false,
): string {
  if (samples.length < 2 || width <= 0 || height <= 0) return "";

  const ordered = rtl ? [...samples].reverse() : samples;
  const mid = height / 2;
  const half = height / 2;
  const step = width / (ordered.length - 1);

  const upper = ordered.map((v, i) => ({
    x: i * step,
    y: mid - Math.max(MIN_AMPLITUDE, v) * half,
  }));

  // Reflect for the lower half, walking back right-to-left so the path closes cleanly.
  const lower = [...upper]
    .reverse()
    .map(({ x, y }) => ({ x, y: mid + (mid - y) }));

  // Move to the start of the top edge, curve across it, line down to the start of the
  // bottom edge, curve back, close. `smoothCurves` emits only the C commands (no move),
  // so the two halves splice together without a stray coordinate.
  const start = `M ${upper[0].x.toFixed(2)} ${upper[0].y.toFixed(2)}`;
  const down = `L ${lower[0].x.toFixed(2)} ${lower[0].y.toFixed(2)}`;
  return `${start} ${smoothCurves(upper)} ${down} ${smoothCurves(lower)} Z`;
}

/** Cubic-Bézier commands (no leading move) approximating a Catmull-Rom spline. */
function smoothCurves(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d +=
      ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}` +
      ` ${c2x.toFixed(2)} ${c2y.toFixed(2)}` +
      ` ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}
