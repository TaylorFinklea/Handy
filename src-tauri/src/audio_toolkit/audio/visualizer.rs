//! Vocal-band level meter driving the recording overlay's waveform.
//!
//! Emits one calibrated dBFS value per frame. It deliberately holds no opinion about
//! how that value should *look* — auto-gain, curve shaping and the attack/release
//! envelope all live in the frontend (`src/overlay/waveform.ts`), where they can be
//! tuned against a real voice behind Vite's hot reload. This module's only job is to
//! be correct.
//!
//! A time-domain 4-pole band-pass (two cascaded Butterworth biquads) restricted to the
//! vocal band, followed by RMS, replaces the FFT this used to run. For a single scalar
//! the FFT was ~10x the cost for no extra information, and its window-gain
//! normalization was the source of a real calibration bug: the old code divided the
//! magnitude by `window_size`, which under-read by ~9-17 dB depending on bucket width.
//! Time-domain RMS needs no window correction at all — a full-scale sine is 0.707 RMS,
//! i.e. -3 dBFS, by definition.

/// Level reported for digital silence. Keeps `20*log10(0)` from producing -inf/NaN.
const SILENCE_DBFS: f32 = -90.0;

/// Target level update rate. The overlay interpolates between these in the webview, so
/// this only has to be fast enough to track syllables, not to animate smoothly.
const TARGET_HZ: f32 = 30.0;

/// Butterworth Q for a maximally-flat passband.
const BUTTERWORTH_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// One biquad section, transposed direct form II.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// RBJ cookbook coefficients, normalised by a0.
    fn new(kind: FilterKind, sample_rate: f32, cutoff_hz: f32) -> Self {
        // Keep the cutoff below Nyquist; a cutoff at or above it makes the
        // coefficients degenerate.
        let cutoff = cutoff_hz.clamp(1.0, sample_rate / 2.0 - 1.0);
        let w0 = 2.0 * std::f32::consts::PI * cutoff / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * BUTTERWORTH_Q);

        let (b0, b1, b2) = match kind {
            FilterKind::HighPass => {
                let k = (1.0 + cos_w0) / 2.0;
                (k, -(1.0 + cos_w0), k)
            }
            FilterKind::LowPass => {
                let k = (1.0 - cos_w0) / 2.0;
                (k, 1.0 - cos_w0, k)
            }
        };
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

#[derive(Clone, Copy)]
enum FilterKind {
    HighPass,
    LowPass,
}

pub struct AudioVisualiser {
    high_pass: Biquad,
    low_pass: Biquad,
    /// Running sum of squares of the filtered samples in the frame being accumulated.
    sum_sq: f64,
    samples_in_frame: usize,
    frame_size: usize,
}

impl AudioVisualiser {
    /// `freq_min`/`freq_max` bound the vocal band the meter responds to, so keyboard
    /// rumble and hiss cannot drive the waveform.
    pub fn new(sample_rate: u32, freq_min: f32, freq_max: f32) -> Self {
        let sr = sample_rate as f32;
        // One frame per ~1/TARGET_HZ of audio, so the update rate is independent of the
        // device's chunk size. Floored so a very low sample rate still produces frames.
        let frame_size = ((sr / TARGET_HZ).round() as usize).max(64);

        Self {
            high_pass: Biquad::new(FilterKind::HighPass, sr, freq_min),
            low_pass: Biquad::new(FilterKind::LowPass, sr, freq_max),
            sum_sq: 0.0,
            samples_in_frame: 0,
            frame_size,
        }
    }

    /// Feed captured samples. Returns the band-limited level in dBFS once a full frame
    /// has accumulated, otherwise `None`.
    ///
    /// Only the *last* completed frame in a chunk is reported: chunks are ~10-20 ms and
    /// frames ~33 ms, so this yields at most one level per chunk and never queues a
    /// backlog of stale levels.
    pub fn feed(&mut self, samples: &[f32]) -> Option<f32> {
        let mut level = None;

        for &sample in samples {
            let filtered = self.low_pass.process(self.high_pass.process(sample));
            self.sum_sq += (filtered as f64) * (filtered as f64);
            self.samples_in_frame += 1;

            if self.samples_in_frame >= self.frame_size {
                let mean_sq = self.sum_sq / self.samples_in_frame as f64;
                let rms = mean_sq.sqrt() as f32;
                level = Some(if rms > 0.0 {
                    (20.0 * rms.log10()).max(SILENCE_DBFS)
                } else {
                    SILENCE_DBFS
                });
                self.sum_sq = 0.0;
                self.samples_in_frame = 0;
            }
        }

        level
    }

    /// Clear filter and frame state between recordings, so one session's tail cannot
    /// bleed into the next.
    pub fn reset(&mut self) {
        self.high_pass.reset();
        self.low_pass.reset();
        self.sum_sq = 0.0;
        self.samples_in_frame = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    fn meter() -> AudioVisualiser {
        AudioVisualiser::new(SR, 400.0, 4000.0)
    }

    /// Feed a sine and return the last reported level, discarding the first half so the
    /// filter's startup transient is not measured.
    fn read_sine(freq: f32, amplitude: f32) -> f32 {
        let mut v = meter();
        let n = SR as usize; // 1 second
        let mut last = SILENCE_DBFS;
        for i in 0..n {
            let t = i as f32 / SR as f32;
            let s = amplitude * (2.0 * std::f32::consts::PI * freq * t).sin();
            if let Some(db) = v.feed(&[s]) {
                if i > n / 2 {
                    last = db;
                }
            }
        }
        last
    }

    /// Two-point absolute calibration. Pins the *offset* as well as the slope — a ratio
    /// test alone ("halving the input drops it 6 dB") is satisfied by any 20*log10
    /// mapping by construction, including the miscalibrated one this replaces.
    #[test]
    fn calibration_is_absolute_at_two_points() {
        // A full-scale sine is 0.707 RMS = -3.01 dBFS; the band-pass costs ~0.13 dB of
        // passband loss at 1 kHz.
        let full = read_sine(1000.0, 1.0);
        assert!(
            (full - -3.01).abs() < 0.5,
            "full-scale 1kHz sine should read ~-3.01 dBFS, got {full:.2}"
        );

        let quiet = read_sine(1000.0, 0.1);
        assert!(
            (quiet - -23.01).abs() < 0.5,
            "-20 dBFS 1kHz sine should read ~-23.01 dBFS, got {quiet:.2}"
        );
    }

    /// The band edges are where the filter is *defined*, so testing them validates the
    /// design far more sharply than an arbitrary "far-out tone is quieter" assertion.
    #[test]
    fn band_edges_sit_at_minus_3db() {
        let mid = read_sine(1000.0, 1.0);
        for edge in [400.0, 4000.0] {
            let at_edge = read_sine(edge, 1.0);
            let drop = mid - at_edge;
            assert!(
                (drop - 3.0).abs() < 1.0,
                "{edge} Hz should be ~3 dB below passband, was {drop:.2} dB"
            );
        }
    }

    /// Rumble and hiss must not drive the waveform. (Note: a tone *just* outside the
    /// band is only ~3 dB down — that is inherent to a 4-pole filter, not a defect —
    /// so rejection is asserted where it actually matters.)
    #[test]
    fn out_of_band_energy_is_rejected() {
        let mid = read_sine(1000.0, 1.0);
        let rumble = mid - read_sine(100.0, 1.0);
        let hiss = mid - read_sine(10_000.0, 1.0);
        assert!(rumble > 20.0, "100Hz rumble only {rumble:.1} dB down");
        assert!(hiss > 15.0, "10kHz hiss only {hiss:.1} dB down");
    }

    #[test]
    fn silence_reports_the_floor_not_infinity() {
        let mut v = meter();
        let mut last = None;
        for _ in 0..SR {
            if let Some(db) = v.feed(&[0.0]) {
                last = Some(db);
            }
        }
        let db = last.expect("a second of audio must produce at least one frame");
        assert!(db.is_finite(), "silence produced a non-finite level: {db}");
        assert_eq!(db, SILENCE_DBFS);
    }

    /// `reset()` runs on Cmd::Start; without clearing filter state, a loud tail from the
    /// previous recording rings into the first frames of the next one.
    #[test]
    fn reset_clears_filter_state_between_recordings() {
        let mut v = meter();
        // Ring the filter hard.
        for i in 0..SR as usize / 10 {
            let t = i as f32 / SR as f32;
            let _ = v.feed(&[(2.0 * std::f32::consts::PI * 1000.0 * t).sin()]);
        }
        v.reset();

        // The very first frame after reset, on silence, must already be at the floor.
        let mut first = None;
        for _ in 0..SR as usize / 10 {
            if first.is_none() {
                if let Some(db) = v.feed(&[0.0]) {
                    first = Some(db);
                }
            }
        }
        assert_eq!(
            first.expect("expected a frame"),
            SILENCE_DBFS,
            "filter state survived reset and rang into the next recording"
        );
    }

    /// The update rate must not depend on how the device chunks its callbacks.
    #[test]
    fn frame_rate_is_independent_of_chunk_size() {
        for chunk in [1usize, 64, 480, 4096] {
            let mut v = meter();
            let mut frames = 0;
            let total = SR as usize; // 1 second
            let mut i = 0;
            while i < total {
                let n = chunk.min(total - i);
                let block: Vec<f32> = (0..n).map(|_| 0.0).collect();
                if v.feed(&block).is_some() {
                    frames += 1;
                }
                i += n;
            }
            // ~30 frames/sec, allowing for at most one level reported per chunk.
            let expected = TARGET_HZ as i32;
            if chunk <= 480 {
                assert!(
                    (frames - expected).abs() <= 2,
                    "chunk {chunk}: expected ~{expected} frames/sec, got {frames}"
                );
            } else {
                // Chunks longer than a frame report at most once per chunk by design.
                assert!(frames > 0, "chunk {chunk}: no frames produced");
            }
        }
    }
}
