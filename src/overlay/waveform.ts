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
/** Floor on the dynamic range. Without it, a silent room's tiny fluctuations would be
 *  stretched to full scale and the wave would thrash on nothing. */
const MIN_SPAN_DB = 12;
/** The noise floor drops quickly to a new minimum but creeps up only very slowly, so
 *  sustained speech cannot drag the floor up behind it. */
const NOISE_FALL = 0.25;
const NOISE_RISE = 0.0005;
/** ~2s of speech history at ~30Hz, used for the percentile. */
const SPEECH_WINDOW = 64;
/** Cold-start values. speech_ref starts low and noise_floor starts at the silence floor,
 *  so the first words read near full scale and the gain adapts *down* from there. The
 *  reverse would leave the overlay dead exactly when the user starts talking — the one
 *  moment it must not be. */
const INITIAL_SPEECH_REF = -60;
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
    const alpha = db < this.noiseFloor ? NOISE_FALL : NOISE_RISE;
    this.noiseFloor += (db - this.noiseFloor) * alpha;

    // Only levels that are plausibly speech update the reference. Without this the
    // reference tracks whatever is loudest in the room — a fan, the AC — and in a noisy
    // room speech never lifts off the floor: exactly the bug this replaces.
    if (db > this.noiseFloor + SPEECH_MARGIN_DB) {
      this.speech.push(db);
      if (this.speech.length > SPEECH_WINDOW) this.speech.shift();
      this.speechRef = percentile(this.speech, 0.9);
    }

    const span = Math.max(MIN_SPAN_DB, this.speechRef - this.noiseFloor);
    return clamp01((db - this.noiseFloor) / span);
  }

  reset(): void {
    this.noiseFloor = INITIAL_NOISE_FLOOR;
    this.speechRef = INITIAL_SPEECH_REF;
    this.speech = [];
  }
}

// --- Envelope ---------------------------------------------------------------------

/** Fast enough to catch a syllable's onset. */
const ATTACK_MS = 15;
/** Slow enough that the wave settles rather than snapping to zero between words. */
const RELEASE_MS = 180;

/**
 * Asymmetric smoothing: quick to rise, gentle to fall. This asymmetry is what makes the
 * wave read as *alive* — the symmetric filter it replaces damped attacks exactly as hard
 * as decays, which is why speech barely registered.
 *
 * Coefficients derive from elapsed time, not an assumed frame count, so a dropped frame
 * changes nothing about the perceived response.
 */
export class Envelope {
  private value = 0;

  process(target: number, dtMs: number): number {
    const tau = target > this.value ? ATTACK_MS : RELEASE_MS;
    // Guard against a pathological dt (e.g. a backgrounded tab resuming) snapping the
    // envelope; exp() handles it correctly but clamp keeps it sane.
    const alpha = 1 - Math.exp(-Math.max(0, dtMs) / tau);
    this.value += (target - this.value) * alpha;
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

  const top = smoothThrough(upper);
  // Reflect for the lower half, walking back right-to-left so the path closes cleanly.
  const lower = [...upper]
    .reverse()
    .map(({ x, y }) => ({ x, y: mid + (mid - y) }));
  const bottom = smoothThrough(lower);

  // `top` already starts with M; splice the return leg on with an L into its first point.
  return `${top} L ${lower[0].x.toFixed(2)} ${lower[0].y.toFixed(2)} ${bottom.slice(
    bottom.indexOf(" ", 2) + 1,
  )} Z`;
}

/** Catmull-Rom spline through the points, emitted as cubic Béziers. */
function smoothThrough(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
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
