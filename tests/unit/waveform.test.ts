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

  test("a quiet mic and a loud mic both produce a clearly visible wave", () => {
    const quiet = new AutoGain();
    sustain(quiet, SILENCE_DBFS, 60);
    const quietSpeech = sustain(quiet, -55, 90);

    const loud = new AutoGain();
    sustain(loud, SILENCE_DBFS, 60);
    const loudSpeech = sustain(loud, -15, 90);

    // Mic independence is the whole promise of auto-gain: neither the quiet nor the loud
    // mic is stuck near the floor. (Headroom means normal speech sits mid-wave, not at the
    // top — see the headroom test — so this asserts "clearly visible", not "peaked".)
    expect(quietSpeech).toBeGreaterThan(0.45);
    expect(loudSpeech).toBeGreaterThan(0.45);
  });

  test("normal speech leaves headroom; a raised voice reaches higher", () => {
    // Realistic input: speech with silence gaps, so the noise floor settles to the
    // room rather than staying pinned at the initial floor.
    const gain = new AutoGain();
    const speak = (db: number) => {
      for (let i = 0; i < 8; i++) gain.push(db); // a word
      for (let i = 0; i < 4; i++) gain.push(SILENCE_DBFS); // a gap
    };
    let normal = 0;
    for (let i = 0; i < 12; i++) {
      speak(-35);
      normal = gain.push(-35);
    }
    // Normal speech should sit mid-wave, not pinned at the top — the whole point of the
    // headroom change.
    expect(normal).toBeGreaterThan(0.25);
    expect(normal).toBeLessThan(0.8);

    // A raised voice must read clearly higher than normal speech.
    let loud = 0;
    for (let i = 0; i < 4; i++) loud = gain.push(-18);
    expect(loud).toBeGreaterThan(normal + 0.1);
  });

  test("near-floor noise is gated to a flat baseline (no tail jitter)", () => {
    // Realistic session: room tone at -63 with speech bursts at -33, alternating. The
    // floor climbs to meet the room tone, so residual noise at the tail of a word reads
    // flat instead of jittering at mid-wave (the reported bug).
    const gain = new AutoGain();
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 10; i++) gain.push(-63); // a gap: room tone
      for (let i = 0; i < 8; i++) gain.push(-33); // a word
    }

    // The floor has tracked room tone, so a level right at it renders flat.
    let roomTone = 0;
    for (let i = 0; i < 10; i++) roomTone = gain.push(-63);
    expect(roomTone).toBeLessThan(0.08);

    // Speech well above the floor is unaffected by the gate.
    const speech = gain.push(-33);
    expect(speech).toBeGreaterThan(0.3);
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

  test("small flicker is smoothed away while a real onset stays fast", () => {
    // Fade-out flicker: the amplitude wobbles by small amounts. The output must be far
    // calmer than the input — this is the tail-jitter fix.
    const env = new Envelope();
    env.process(0.2, 33); // settle near 0.2
    const inputs = [0.28, 0.13, 0.3, 0.12, 0.27, 0.14];
    const outputs = inputs.map((v) => env.process(v, 33));
    const range = Math.max(...outputs) - Math.min(...outputs);
    const inputRange = Math.max(...inputs) - Math.min(...inputs);
    expect(range).toBeLessThan(inputRange * 0.5); // wobble at least halved

    // A genuine speech onset (large jump) still rises fast in a single frame.
    const onset = new Envelope();
    const rose = onset.process(0.8, 33);
    expect(rose).toBeGreaterThan(0.6);
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

  test("every command has a valid argument count", () => {
    // A malformed path (e.g. an L with three numbers) makes WebKit drop the whole
    // path and render nothing — the "doesn't move at all" bug. Validate structurally.
    const d = buildWavePath([0.1, 0.4, 0.8, 0.5, 0.2, 0.6, 0.9], 120, 26);
    const argsPerCommand: Record<string, number> = { M: 2, L: 2, C: 6, Z: 0 };
    const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
    let i = 0;
    while (i < tokens.length) {
      const cmd = tokens[i++];
      expect(argsPerCommand).toHaveProperty(cmd);
      const need = argsPerCommand[cmd];
      for (let a = 0; a < need; a++) {
        // Each argument slot must be a number, not another command.
        expect(tokens[i + a]).toMatch(/^-?\d*\.?\d+$/);
      }
      i += need;
    }
    // And it must consume exactly — no leftover tokens.
    expect(i).toBe(tokens.length);
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
