import { describe, expect, test } from "bun:test";
import {
  AutoGain,
  buildWavePath,
  Envelope,
  History,
  historyLengthFor,
  percentile,
  PX_PER_SAMPLE,
  SILENCE_DBFS,
} from "../../src/overlay/waveform";

/** Feed a sustained level and return the last normalized output. */
const sustain = (gain: AutoGain, db: number, frames: number): number => {
  let out = 0;
  for (let i = 0; i < frames; i++) out = gain.push(db);
  return out;
};

describe("AutoGain", () => {
  test("a noisy room still lets speech reach the top of the range", () => {
    // The failure this design exists to prevent: a fan at -40 dBFS with speech only
    // 10 dB above it. A naive gain adapts to the fan and speech never lifts off.
    const gain = new AutoGain();
    sustain(gain, -40, 120); // fan alone — establishes the floor
    const speech = sustain(gain, -30, 60);
    expect(speech).toBeGreaterThan(0.6);
  });

  test("a quiet mic and a loud mic both reach the top of the range", () => {
    const quiet = new AutoGain();
    sustain(quiet, SILENCE_DBFS, 60);
    const quietSpeech = sustain(quiet, -55, 90);

    const loud = new AutoGain();
    sustain(loud, SILENCE_DBFS, 60);
    const loudSpeech = sustain(loud, -15, 90);

    // Mic independence is the whole promise of auto-gain.
    expect(quietSpeech).toBeGreaterThan(0.6);
    expect(loudSpeech).toBeGreaterThan(0.6);
  });

  test("silence is never amplified into a full-scale wave", () => {
    const gain = new AutoGain();
    const out = sustain(gain, SILENCE_DBFS, 200);
    // Silence must read flat — that is the "am I being heard" signal.
    expect(out).toBeLessThan(0.1);
  });

  test("one loud transient does not shrink the speech that follows", () => {
    const gain = new AutoGain();
    sustain(gain, -30, 60); // normal speech
    gain.push(0); // a door slam, full scale, single frame
    const after = sustain(gain, -30, 30);
    // A running-peak reference would be pinned by the slam and squash this. A P90
    // percentile discards it.
    expect(after).toBeGreaterThan(0.5);
  });

  test("cold start: the very first words already read loud", () => {
    // The worst possible moment for a dead overlay is the instant the user starts
    // talking, so the gain must start biased high and adapt *down*.
    const gain = new AutoGain();
    const first = sustain(gain, -30, 15); // ~500ms at 30Hz
    expect(first).toBeGreaterThan(0.5);
  });

  test("reset() clears adaptation between recordings", () => {
    const gain = new AutoGain();
    sustain(gain, -10, 120);
    gain.reset();
    const fresh = sustain(gain, -30, 15);
    expect(fresh).toBeGreaterThan(0.5);
  });
});

describe("Envelope", () => {
  test("attacks faster than it releases", () => {
    const rise = new Envelope();
    const fall = new Envelope();

    // Same elapsed time, opposite directions.
    const afterAttack = rise.process(1, 30);
    fall.process(1, 10_000); // saturate to 1
    const afterRelease = fall.process(0, 30);

    // Rose most of the way in 30ms; fell only a little in the same 30ms.
    expect(afterAttack).toBeGreaterThan(0.75);
    expect(afterRelease).toBeGreaterThan(0.75);
  });

  test("response depends on elapsed time, not frame count", () => {
    const a = new Envelope();
    const b = new Envelope();
    // One 30ms step vs three 10ms steps must land in the same place.
    const once = a.process(1, 30);
    b.process(1, 10);
    b.process(1, 10);
    const thrice = b.process(1, 10);
    expect(Math.abs(once - thrice)).toBeLessThan(0.01);
  });
});

describe("History", () => {
  test("density is constant across overlay widths", () => {
    // The pill and the Live panel differ ~2.3x in width. Constant px/sample means the
    // panel shows a longer trail, not a stretched one.
    expect(historyLengthFor(172)).toBe(Math.round(172 / PX_PER_SAMPLE));
    expect(historyLengthFor(392)).toBe(Math.round(392 / PX_PER_SAMPLE));
  });

  test("keeps the newest samples when it overflows", () => {
    const h = new History(3);
    [1, 2, 3, 4].forEach((v) => h.push(v));
    expect(h.values()).toEqual([2, 3, 4]);
  });

  test("resize preserves the newest samples", () => {
    const h = new History(4);
    [1, 2, 3, 4].forEach((v) => h.push(v));
    h.resize(2);
    expect(h.values()).toEqual([3, 4]);
  });
});

describe("buildWavePath", () => {
  const samples = [0, 0.5, 1, 0.5, 0];

  test("is symmetric about the centerline", () => {
    const d = buildWavePath(samples, 100, 40);
    const ys = [...d.matchAll(/-?\d+\.\d+ (-?\d+\.\d+)/g)].map((m) =>
      parseFloat(m[1]),
    );
    // Every y has a mirror across the midline (20), within rounding.
    for (const y of ys) {
      const mirrored = 40 - y;
      expect(ys.some((other) => Math.abs(other - mirrored) < 0.05)).toBe(true);
    }
  });

  test("spans the full width and closes", () => {
    const d = buildWavePath(samples, 100, 40);
    expect(d.startsWith("M 0.00")).toBe(true);
    expect(d.trim().endsWith("Z")).toBe(true);
    expect(d).toContain("100.00");
  });

  test("rtl puts the newest sample on the left", () => {
    const rising = [0, 0.25, 0.5, 0.75, 1];
    const ltr = buildWavePath(rising, 100, 40);
    const rtl = buildWavePath(rising, 100, 40, true);
    expect(ltr).not.toEqual(rtl);

    // In LTR the newest (loudest) sample is at the right edge, so the path's first
    // point (x=0) is the quietest — nearest the centerline (y=20).
    const firstY = (d: string) => parseFloat(d.split(" ")[2]);
    expect(firstY(ltr)).toBeGreaterThan(firstY(rtl));
  });

  test("degenerate input yields an empty path rather than NaN", () => {
    expect(buildWavePath([], 100, 40)).toBe("");
    expect(buildWavePath([1], 100, 40)).toBe("");
    expect(buildWavePath(samples, 0, 40)).toBe("");
  });
});

describe("percentile", () => {
  test("ignores a single outlier at p90", () => {
    const normal = new Array(20).fill(-30);
    expect(percentile([...normal, 0], 0.9)).toBeLessThan(-25);
  });
});
