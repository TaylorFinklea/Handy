import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import {
  AutoGain,
  buildWavePath,
  Envelope,
  History,
  historyLengthFor,
  PX_PER_SAMPLE,
} from "./waveform";

type OverlayState = "recording" | "streaming" | "transcribing" | "processing";

// Drawing height of the wave, in the SVG's own coordinate space.
const WAVE_HEIGHT = 26;
// The backend meters at ~30Hz (see audio_toolkit/audio/visualizer.rs). The wave scrolls
// one sample per level, so this is also the cadence the scroll interpolates against.
const LEVEL_INTERVAL_MS = 1000 / 30;
// Redraw cap. Input arrives at ~30Hz, so a 60Hz loop would buy nothing but compositing
// work: the overlay is a transparent always-on-top panel, and every frame forces the
// compositor to re-blend the desktop behind it.
const DRAW_INTERVAL_MS = 1000 / 30;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);

  // --- Waveform pipeline. The DOM nodes are written directly rather than through React
  // state: the wave redraws ~30x/sec, and re-rendering the whole overlay at that rate to
  // change one path attribute is pure waste.
  const gainRef = useRef(new AutoGain());
  const envelopeRef = useRef(new Envelope());
  const historyRef = useRef(new History(historyLengthFor(120)));
  const lastLevelAtRef = useRef(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const scrollRef = useRef<SVGGElement>(null);
  const [waveWidth, setWaveWidth] = useState(120);
  // The event listener is registered once and never re-created, so it cannot close over
  // `isVisible`; it reads the live value through a ref instead.
  const isVisibleRef = useRef(false);
  isVisibleRef.current = isVisible;

  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);

  // Mirrored into refs so the one-time event listener never reads a stale value.
  const waveWidthRef = useRef(waveWidth);
  waveWidthRef.current = waveWidth;
  const rtlRef = useRef(direction === "rtl");
  rtlRef.current = direction === "rtl";

  // Writes the wave straight to the DOM. `offset` shifts it by a fraction of one
  // sample so the scroll is continuous rather than stepping 2px at each new level.
  // Reads only refs, so the listener's captured copy stays correct.
  function drawWave(offset: number) {
    const path = pathRef.current;
    if (!path) return;
    // Draw one sample wider than the viewport; that extra column is what slides in.
    const d = buildWavePath(
      historyRef.current.values(),
      waveWidthRef.current + PX_PER_SAMPLE,
      WAVE_HEIGHT,
      rtlRef.current,
    );
    path.setAttribute("d", d);
    if (scrollRef.current) {
      // In RTL the wave grows from the left, so it slides the other way.
      const dx = rtlRef.current ? offset : -offset;
      scrollRef.current.setAttribute("transform", `translate(${dx} 0)`);
    }
  }

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        // Start every recording from a clean slate: otherwise the wave opens showing
        // the tail of the previous session, and auto-gain carries over its adaptation.
        gainRef.current.reset();
        envelopeRef.current.reset();
        historyRef.current.reset();
        lastLevelAtRef.current = 0;

        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        if (overlayState === "recording" || overlayState === "streaming") {
          setStreamText({ committed: "", tentative: "" });
        }
        if (overlayState === "streaming") {
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
      });

      // One calibrated vocal-band level in dBFS. Auto-gain, the attack/release envelope
      // and the history all live in ./waveform.ts.
      const unlistenLevel = await listen<number>("mic-level", (event) => {
        // The backend already stops emitting to a hidden overlay; this is the second
        // half of that guard. Doing the DSP for a window nobody is looking at is the
        // per-event WebKit allocation that issue #1279 is about.
        if (!isVisibleRef.current) return;

        const now = performance.now();
        const dt = lastLevelAtRef.current
          ? now - lastLevelAtRef.current
          : LEVEL_INTERVAL_MS;
        lastLevelAtRef.current = now;

        const amplitude = envelopeRef.current.process(
          gainRef.current.push(event.payload),
          dt,
        );
        historyRef.current.push(amplitude);

        // Under reduced motion there is no animation loop, so draw on the event itself.
        if (prefersReducedMotion()) drawWave(0);
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed timer while the Live overlay is visible.
  useEffect(() => {
    if (state !== "streaming" || !isVisible) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible]);

  // The card morphs width between the pill and the open Live panel. History is sized in
  // samples-per-pixel, so the wave keeps the same texture at either width instead of
  // being stretched to fit.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const w = svg.clientWidth || svg.getBoundingClientRect().width;
      if (w > 0 && Math.abs(w - waveWidthRef.current) >= 1) {
        setWaveWidth(w);
        historyRef.current.resize(historyLengthFor(w));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [state, isVisible]);

  // Scroll/redraw loop. Runs only while the overlay is actually showing a live waveform —
  // never behind a hidden overlay, and never during the transcribing/processing rows,
  // which show a spinner instead.
  const listening =
    isVisible && (state === "recording" || state === "streaming");
  useEffect(() => {
    if (!listening || prefersReducedMotion()) return;
    let raf = 0;
    let lastDraw = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - lastDraw < DRAW_INTERVAL_MS) return;
      lastDraw = t;
      // How far we are between the last level and the next one due, so the wave slides
      // continuously instead of jumping one sample-width per event.
      const since = performance.now() - lastLevelAtRef.current;
      const fraction = lastLevelAtRef.current
        ? Math.min(1, since / LEVEL_INTERVAL_MS)
        : 0;
      drawWave(fraction * PX_PER_SAMPLE);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // drawWave reads only refs, so it needs no dependency entry — the loop always sees
    // the current width, direction and history.
  }, [listening]);

  // Stick to the bottom as text streams in — but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // ---- Shared building blocks (one visual language for every overlay form) ----
  // A single fluid wave scrolling with the voice: the newest moment enters at the
  // leading edge and the last ~2s trail behind it. Drawn imperatively (see drawWave) —
  // React never re-renders for a level change.
  const waveform = (
    <svg
      ref={svgRef}
      className="swave"
      viewBox={`0 0 ${waveWidth + PX_PER_SAMPLE} ${WAVE_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g ref={scrollRef}>
        <path ref={pathRef} d="" />
      </g>
    </svg>
  );

  const cancelBtn = (
    <button
      className="sx"
      aria-label="cancel"
      onClick={() => commands.cancelOperation()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 4 L12 12 M12 4 L4 12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );

  // dot (left) | waveform (center) | timer + cancel (right) — same structure for
  // pill & panel, so the Live morph is a pure width change.
  const listeningRow = (showTimer: boolean, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sdot" />
      </div>
      {waveform}
      <div className="sbase-r">
        {showTimer && <span className="stimer">{fmtTime(elapsed)}</span>}
        {showCancel && cancelBtn}
      </div>
    </div>
  );

  // spinner (left) | label (center) | cancel (right) — same 3-zone grid as the
  // listening row, so the label is centered.
  const workingRow = (label: string, showCancel: boolean) => (
    <div className="sbase">
      <div className="sbase-l">
        <span className="sspinner" />
      </div>
      <span className="swork-label">{label}</span>
      <div className="sbase-r">{showCancel && cancelBtn}</div>
    </div>
  );

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // Keep the panel open whenever there's text — even while finalizing — so the
    // transcript stays put under a working spinner instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText;
    const collapsed = working && !hasText;

    return (
      <div dir={direction} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            isVisible ? "" : "leaving"
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              <div
                className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                ref={capRef}
                onScroll={handleStreamScroll}
              >
                <p>
                  <span className="committed">
                    {streamText.committed ? streamText.committed + " " : ""}
                  </span>
                  <span className="tentative">{streamText.tentative}</span>
                  {/* Drop the blinking caret once finalizing — it's no longer
                      capturing, and a static spinner conveys the work. */}
                  {!working && <span className="scaret" />}
                </p>
              </div>
            </div>
          </div>
          {working
            ? workingRow(
                workKind === "polishing"
                  ? t("overlay.processing")
                  : t("overlay.transcribing"),
                true,
              )
            : listeningRow(open, true)}
        </div>
      </div>
    );
  }

  // ---- Minimal overlay: exactly one row at a time — waveform (recording), or a
  // spinner + label (transcribing / processing). Never both. The pill animates its
  // width between them; the cancel button is in both rows so it stays put.
  const working = state === "transcribing" || state === "processing";
  const workLabel =
    state === "processing"
      ? t("overlay.processing")
      : t("overlay.transcribing");

  return (
    <div
      dir={direction}
      className={`ov-stage ${position} ov-fade ${isVisible ? "show" : ""}`}
    >
      <div
        className={`scard compact ${working && isVisible ? "cworking" : ""}`}
      >
        {working ? workingRow(workLabel, true) : listeningRow(false, true)}
      </div>
    </div>
  );
};

export default RecordingOverlay;
