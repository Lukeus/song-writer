import { useEffect, useRef, useState } from "react";
import { useGlobalAudio } from "../audio/GlobalAudioContext";
import { StudioIcon } from "./StudioIcons";
import type { EqBand, EqBandType } from "../audio/types";

// Logarithmic frequency mapping
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -15;
const MAX_DB = 15;

function freqToX(freq: number, width: number): number {
  const minLog = Math.log10(MIN_FREQ);
  const maxLog = Math.log10(MAX_FREQ);
  const freqLog = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
  return ((freqLog - minLog) / (maxLog - minLog)) * width;
}

function xToFreq(x: number, width: number): number {
  const minLog = Math.log10(MIN_FREQ);
  const maxLog = Math.log10(MAX_FREQ);
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.pow(10, minLog + ratio * (maxLog - minLog));
}

function dbToY(db: number, height: number): number {
  const clampedDb = Math.max(MIN_DB, Math.min(MAX_DB, db));
  const ratio = (clampedDb - MIN_DB) / (MAX_DB - MIN_DB);
  return height - ratio * height;
}

function yToDb(y: number, height: number): number {
  const ratio = 1 - Math.max(0, Math.min(1, y / height));
  return MIN_DB + ratio * (MAX_DB - MIN_DB);
}

function formatFreq(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(1) : k.toFixed(1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function formatBandType(type: EqBandType): string {
  switch (type) {
    case "highpass":
      return "HPF";
    case "lowshelf":
    case "highshelf":
      return "SHELF";
    case "lowpass":
      return "LPF";
    case "peaking":
    default:
      return "PEAK";
  }
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function ParametricEqCanvas({
  selectedBandId: externalSelectedBandId,
  onSelectBand,
}: {
  selectedBandId?: number | null;
  onSelectBand?: (id: number | null) => void;
}) {
  const {
    eqBands,
    isEqBypassed,
    updateEqBand,
    getPrimaryAnalyser,
    getRefAnalyser,
    getBiquadFilterNodes,
    referenceTrack,
    activeSource,
    setActiveSource,
    isPlaying,
    currentTime,
    duration,
    togglePlay,
    seek,
    loop,
    setLoop,
  } = useGlobalAudio();

  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [internalSelectedBandId, setInternalSelectedBandId] = useState<number>(5);
  const [hoveredBandId, setHoveredBandId] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHoldingRef, setIsHoldingRef] = useState(false);
  const previousSourceRef = useRef<"primary" | "reference">("primary");

  const selectedBandId = externalSelectedBandId !== undefined ? externalSelectedBandId : internalSelectedBandId;
  const setSelectedBandId = (id: number) => {
    setInternalSelectedBandId(id);
    if (onSelectBand) onSelectBand(id);
  };

  const draggingBandIdRef = useRef<number | null>(null);

  // Frequencies array for getFrequencyResponse
  const numPoints = 256;
  const frequencyPoints = useRef<Float32Array>(new Float32Array(numPoints));

  useEffect(() => {
    const minLog = Math.log10(MIN_FREQ);
    const maxLog = Math.log10(MAX_FREQ);
    const freqs = new Float32Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
      const ratio = i / (numPoints - 1);
      freqs[i] = Math.pow(10, minLog + ratio * (maxLog - minLog));
    }
    frequencyPoints.current = freqs;
  }, [numPoints]);

  // Keyboard shortcut listener for 'R' key (Hold R to hear reference track)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if ((e.key === "r" || e.key === "R") && !e.repeat && referenceTrack) {
        previousSourceRef.current = activeSource;
        setIsHoldingRef(true);
        setActiveSource("reference");
      } else if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      if ((e.key === "r" || e.key === "R") && referenceTrack) {
        setIsHoldingRef(false);
        setActiveSource(previousSourceRef.current || "primary");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [referenceTrack, activeSource, setActiveSource, togglePlay]);

  // Auto-resize canvas to fill its container
  useEffect(() => {
    const updateCanvasSize = () => {
      const canvas = canvasRef.current;
      const container = canvasContainerRef.current;
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height || 360);

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
    };

    updateCanvasSize();
    window.addEventListener("resize", updateCanvasSize);
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, []);

  // Main 60 FPS Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const primAnalyser = getPrimaryAnalyser();
    const refAnalyser = getRefAnalyser();
    const filterNodes = getBiquadFilterNodes();

    const primFreqData = primAnalyser ? new Uint8Array(primAnalyser.frequencyBinCount) : null;
    const refFreqData = refAnalyser ? new Uint8Array(refAnalyser.frequencyBinCount) : null;

    const magResponse = new Float32Array(numPoints);
    const phaseResponse = new Float32Array(numPoints);
    const totalMagDb = new Float32Array(numPoints);

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      // 1. Draw Studio Background
      ctx.fillStyle = "#0a0e14";
      ctx.fillRect(0, 0, w, h);

      // 2. Draw Precision dB Grid Lines (+12, +6, 0 dB, -6, -12)
      ctx.lineWidth = 1;
      const dbSteps = [12, 6, 0, -6, -12];
      ctx.textAlign = "left";
      ctx.font = "500 10.5px 'Source Code Pro', monospace";

      dbSteps.forEach((db) => {
        const y = dbToY(db, h);
        const isCenter = db === 0;

        ctx.strokeStyle = isCenter ? "rgba(255, 255, 255, 0.18)" : "rgba(255, 255, 255, 0.05)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.fillStyle = isCenter ? "rgba(238, 242, 246, 0.6)" : "rgba(92, 106, 120, 0.65)";
        const label = isCenter ? "0 dB" : `${db > 0 ? "+" : ""}${db}`;
        ctx.fillText(label, 12, y + 3.5);
      });

      // 3. Draw Frequency Vertical Grid Lines (100, 500, 1k, 5k, 10k)
      const freqMarkers = [100, 500, 1000, 5000, 10000];
      ctx.textAlign = "center";
      freqMarkers.forEach((f) => {
        const x = freqToX(f, w);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h - 20);
        ctx.stroke();

        ctx.fillStyle = "rgba(92, 106, 120, 0.7)";
        const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(label, x, h - 6);
      });

      // 4. Draw Reference Track Spectrum (Track B: Peach/Slate Translucent Filled Curve)
      if (refAnalyser && refFreqData) {
        refAnalyser.getByteFrequencyData(refFreqData);
        ctx.beginPath();
        const nyquist = 24000;
        let started = false;

        for (let i = 0; i < numPoints; i++) {
          const freq = frequencyPoints.current[i];
          const bin = Math.min(
            refFreqData.length - 1,
            Math.round((freq / nyquist) * refFreqData.length)
          );
          const val = refFreqData[bin] / 255.0;
          // Smooth scaled amplitude
          const y = h - 20 - val * (h * 0.7);
          const x = freqToX(freq, w);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.lineTo(w, h - 20);
        ctx.lineTo(0, h - 20);
        ctx.closePath();
        ctx.fillStyle = "rgba(255, 187, 124, 0.12)";
        ctx.fill();
      }

      // 5. Draw Primary Track Spectrum (Track A: Dark Cyan Translucent Shaded Curve)
      if (primAnalyser && primFreqData) {
        primAnalyser.getByteFrequencyData(primFreqData);

        const gradient = ctx.createLinearGradient(0, 0, 0, h);
        gradient.addColorStop(0, "rgba(56, 189, 248, 0.28)");
        gradient.addColorStop(0.6, "rgba(56, 189, 248, 0.10)");
        gradient.addColorStop(1, "rgba(56, 189, 248, 0.02)");

        ctx.beginPath();
        const nyquist = 24000;
        let started = false;

        for (let i = 0; i < numPoints; i++) {
          const freq = frequencyPoints.current[i];
          const bin = Math.min(
            primFreqData.length - 1,
            Math.round((freq / nyquist) * primFreqData.length)
          );
          const val = primFreqData[bin] / 255.0;
          const y = h - 20 - val * (h * 0.75);
          const x = freqToX(freq, w);

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.lineTo(w, h - 20);
        ctx.lineTo(0, h - 20);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // 6. Compute Total EQ Frequency Response Curve
      totalMagDb.fill(0);

      if (!isEqBypassed && filterNodes.length > 0) {
        filterNodes.forEach((filter) => {
          try {
            filter.getFrequencyResponse(frequencyPoints.current, magResponse, phaseResponse);
            for (let i = 0; i < numPoints; i++) {
              const mag = magResponse[i];
              if (mag > 0) {
                totalMagDb[i] += 20 * Math.log10(mag);
              }
            }
          } catch {
            // Rebuilding node
          }
        });
      }

      // 7. Draw Glowing Cyan Filter Curve (Matching Studio Design)
      ctx.beginPath();
      for (let i = 0; i < numPoints; i++) {
        const freq = frequencyPoints.current[i];
        const db = Math.max(MIN_DB, Math.min(MAX_DB, totalMagDb[i]));
        const x = freqToX(freq, w);
        const y = dbToY(db, h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = isEqBypassed ? "rgba(100, 116, 139, 0.45)" : "#7cd2ff";
      ctx.lineWidth = 2.5;
      ctx.shadowColor = isEqBypassed ? "transparent" : "rgba(124, 210, 255, 0.75)";
      ctx.shadowBlur = isEqBypassed ? 0 : 12;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 8. Draw Interactive Band Nodes (8 Nodes on the Curve)
      eqBands.forEach((band) => {
        const x = freqToX(band.frequency, w);
        const isBypassType = band.type === "highpass" || band.type === "lowpass";
        const y = dbToY(isBypassType ? 0 : band.gain, h);

        const isSelected = selectedBandId === band.id;
        const isHovered = hoveredBandId === band.id;
        const isDraggingThis = draggingBandIdRef.current === band.id;

        // Outer halo when active or hovered
        if (isSelected || isDraggingThis || isHovered) {
          ctx.beginPath();
          ctx.arc(x, y, isSelected || isDraggingThis ? 14 : 11, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(124, 210, 255, 0.18)";
          ctx.fill();
          ctx.strokeStyle = "rgba(124, 210, 255, 0.65)";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Inner node circle (solid filled for selected, ring for unselected)
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 8.5 : 7, 0, Math.PI * 2);

        if (isSelected) {
          ctx.fillStyle = "#7cd2ff";
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        } else {
          ctx.fillStyle = "#0b0f14";
          ctx.fill();
          ctx.strokeStyle = "#7cd2ff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });

      ctx.restore();
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [
    eqBands,
    isEqBypassed,
    selectedBandId,
    hoveredBandId,
    numPoints,
    getPrimaryAnalyser,
    getRefAnalyser,
    getBiquadFilterNodes,
  ]);

  // Pointer & Drag handlers
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = (canvas.width / (window.devicePixelRatio || 1)) / rect.width;
    const scaleY = (canvas.height / (window.devicePixelRatio || 1)) / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const { x, y } = getCanvasCoords(e);

    let closestBand: EqBand | null = null;
    let closestDist = Infinity;

    eqBands.forEach((band) => {
      const bx = freqToX(band.frequency, w);
      const isBypassType = band.type === "highpass" || band.type === "lowpass";
      const by = dbToY(isBypassType ? 0 : band.gain, h);
      const dist = Math.hypot(x - bx, y - by);
      if (dist < closestDist) {
        closestDist = dist;
        closestBand = band;
      }
    });

    if (closestBand && closestDist <= 32) {
      const bId = (closestBand as EqBand).id;
      setSelectedBandId(bId);
      draggingBandIdRef.current = bId;
      setIsDragging(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const { x, y } = getCanvasCoords(e);

    if (draggingBandIdRef.current !== null) {
      const bandId = draggingBandIdRef.current;
      const band = eqBands.find((b) => b.id === bandId);
      if (!band) return;

      const newFreq = Math.max(20, Math.min(20000, Math.round(xToFreq(x, w))));
      const isBypassType = band.type === "highpass" || band.type === "lowpass";
      const newGain = isBypassType
        ? 0
        : Math.max(MIN_DB, Math.min(MAX_DB, Math.round(yToDb(y, h) * 10) / 10));

      updateEqBand(bandId, { frequency: newFreq, gain: newGain });
    } else {
      let hit: EqBand | null = null;
      let minDist = Infinity;
      for (const band of eqBands) {
        const bx = freqToX(band.frequency, w);
        const isBypassType = band.type === "highpass" || band.type === "lowpass";
        const by = dbToY(isBypassType ? 0 : band.gain, h);
        const dist = Math.hypot(x - bx, y - by);
        if (dist < minDist) {
          minDist = dist;
          hit = band;
        }
      }
      setHoveredBandId(minDist <= 22 && hit ? hit.id : null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    draggingBandIdRef.current = null;
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const targetId = hoveredBandId ?? selectedBandId;
    if (!targetId) return;
    e.preventDefault();

    const band = eqBands.find((b) => b.id === targetId);
    if (!band) return;

    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    const newQ = Math.max(0.1, Math.min(18.0, Math.round((band.q + delta) * 100) / 100));
    updateEqBand(targetId, { q: newQ });
  };

  // Get active selected band info for the floating top-right tooltip card
  const currentSelectedBand = eqBands.find((b) => b.id === selectedBandId) || eqBands[4];

  // Handle Scrubbing on Transport Bar
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = parseFloat(e.target.value);
    seek(targetTime);
  };

  return (
    <div className="studio-eq-workspace">
      {/* 1. Canvas Container with Top Legend and Tooltip Card */}
      <div className="studio-canvas-card" ref={canvasContainerRef}>
        {/* Top-Left Spectrum Legend */}
        <div className="studio-canvas-header-legend">
          <span className="legend-track-a">
            <span className="legend-dash cyan" /> TRACK A
          </span>
          <span className="legend-track-b">
            <span className="legend-dash peach" /> REFERENCE B
          </span>
          <span className="legend-fps">
            <span className="legend-dash slate" /> 60 FPS SPECTRUM
          </span>
        </div>

        {/* Top-Right Floating Band Tooltip */}
        {currentSelectedBand && (
          <div className="studio-band-tooltip-card">
            <div className="tooltip-band-title">
              BAND {currentSelectedBand.id} • {currentSelectedBand.type.toUpperCase()}
            </div>
            <div className="tooltip-band-stats">
              <span className="stat-freq">{formatFreq(currentSelectedBand.frequency)}</span>
              <span className="stat-dot">•</span>
              <span className="stat-gain">
                {currentSelectedBand.type === "highpass" || currentSelectedBand.type === "lowpass"
                  ? "0 dB"
                  : `${currentSelectedBand.gain >= 0 ? "+" : ""}${currentSelectedBand.gain.toFixed(1)} dB`}
              </span>
              <span className="stat-dot">•</span>
              <span className="stat-q">Q {currentSelectedBand.q.toFixed(1)}</span>
            </div>
          </div>
        )}

        {/* 60fps Canvas */}
        <canvas
          ref={canvasRef}
          className={`studio-canvas ${isDragging ? "dragging" : hoveredBandId ? "hovering" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />
      </div>

      {/* 2. 8-Band Strip (01 HPF .. 08 LPF) */}
      <div className="studio-band-strip">
        {eqBands.map((band) => {
          const isSelected = selectedBandId === band.id;
          const bandNumber = band.id < 10 ? `0${band.id}` : `${band.id}`;
          const bandTypeLabel = formatBandType(band.type);

          // Get icon name for this band
          let iconName: any = "peaking";
          if (band.type === "highpass") iconName = "highpass";
          else if (band.type === "lowshelf") iconName = "lowshelf";
          else if (band.type === "highshelf") iconName = "highshelf";
          else if (band.type === "lowpass") iconName = "lowpass";
          else if (band.type === "peaking") {
            iconName = band.gain < 0 ? "notch" : "peaking";
          }

          const gainDisplay =
            band.type === "highpass" || band.type === "lowpass"
              ? "0 dB"
              : `${band.gain >= 0 ? "+" : ""}${band.gain.toFixed(1)}`;

          return (
            <div
              key={band.id}
              className={`studio-band-card ${isSelected ? "selected" : ""}`}
              onClick={() => setSelectedBandId(band.id)}
            >
              <div className="band-card-top">
                <span className="band-num-type">
                  {bandNumber} {bandTypeLabel}
                </span>
                <StudioIcon
                  name={iconName}
                  state={isSelected ? "active" : "rest"}
                  size={16}
                  className="band-curve-icon"
                />
              </div>

              <div className="band-freq-large">{formatFreq(band.frequency)}</div>

              <div className="band-card-footer">
                <span className="band-q-val">Q {band.q.toFixed(2)}</span>
                <span className="band-footer-dot">•</span>
                <span className="band-gain-val">{gainDisplay}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 3. Transport & Playback Strip */}
      <div className="studio-transport-strip">
        <button
          type="button"
          className="studio-play-btn"
          onClick={togglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="studio-time-display">
          <span className="current-time">{formatTime(currentTime)}</span>
          <span className="time-divider">/</span>
          <span className="total-time">{formatTime(duration)}</span>
        </div>

        {/* Progress Scrubber */}
        <div className="studio-scrub-wrap">
          <input
            type="range"
            min="0"
            max={duration > 0 ? duration : 100}
            step="0.1"
            value={currentTime}
            onChange={handleSeek}
            className="studio-scrub-slider"
          />
        </div>

        {/* Loop Chorus Button */}
        <button
          type="button"
          className={`studio-loop-btn ${loop ? "active" : ""}`}
          onClick={() => setLoop(!loop)}
        >
          <StudioIcon name="loop" state={loop ? "active" : "rest"} size={16} />
          <span>LOOP CHORUS</span>
        </button>

        {/* Hold R Reference Shortcut Hint */}
        <div className={`studio-ref-hint ${isHoldingRef ? "active" : ""}`}>
          <span className="hint-mono">HOLD</span>
          <span className="hint-key">R</span>
          <span className="hint-text">TO HEAR REFERENCE</span>
        </div>
      </div>
    </div>
  );
}
