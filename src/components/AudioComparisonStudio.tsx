import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useGlobalAudio } from "../audio/GlobalAudioContext";
import { importAudioFile, type MediaFile } from "../api";

const MIN_FREQ = 20;
const MAX_FREQ = 20000;

function freqToX(freq: number, width: number): number {
  const minLog = Math.log10(MIN_FREQ);
  const maxLog = Math.log10(MAX_FREQ);
  const freqLog = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)));
  return ((freqLog - minLog) / (maxLog - minLog)) * width;
}

export function AudioComparisonStudio({
  songId,
  availableMedia = [],
}: {
  songId?: number;
  availableMedia?: MediaFile[];
}) {
  const {
    primaryTrack,
    referenceTrack,
    activeSource,
    refVolumeOffset,
    syncPlayheads,
    setReferenceTrack,
    setActiveSource,
    togglePlay,
    setRefVolumeOffset,
    setSyncPlayheads,
    getPrimaryAnalyser,
    getRefAnalyser,
  } = useGlobalAudio();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bandDeltas, setBandDeltas] = useState<{
    sub: number;
    lowMid: number;
    mid: number;
    highMid: number;
    air: number;
  }>({ sub: 0, lowMid: 0, mid: 0, highMid: 0, air: 0 });

  // Handle importing a reference track from disk
  const handleImportReference = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Audio Files", extensions: ["mp3", "wav", "m4a", "aiff", "flac", "ogg"] }],
      });
      if (selected && typeof selected === "string" && songId) {
        const file = await importAudioFile(songId, selected);
        setReferenceTrack(file);
      }
    } catch (err) {
      console.warn("Failed to open audio file dialog:", err);
    }
  };

  // Keyboard shortcut listener for instantaneous A/B toggling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      if (e.key === "a" || e.key === "A") {
        setActiveSource("primary");
      } else if (e.key === "b" || e.key === "B") {
        if (referenceTrack) setActiveSource("reference");
      } else if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [referenceTrack, setActiveSource, togglePlay]);

  // Delta Spectrum Render Loop (60 FPS)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const primAnalyser = getPrimaryAnalyser();
    const refAnalyser = getRefAnalyser();

    const numPoints = 160;
    const minLog = Math.log10(MIN_FREQ);
    const maxLog = Math.log10(MAX_FREQ);
    const freqs = new Float32Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
      freqs[i] = Math.pow(10, minLog + (i / (numPoints - 1)) * (maxLog - minLog));
    }

    const primFreqData = primAnalyser ? new Uint8Array(primAnalyser.frequencyBinCount) : null;
    const refFreqData = refAnalyser ? new Uint8Array(refAnalyser.frequencyBinCount) : null;

    let lastMetricsTime = 0;

    const render = (time: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const centerY = h / 2;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0c1017";
      ctx.fillRect(0, 0, w, h);

      // Center baseline (0 dB difference)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(w, centerY);
      ctx.stroke();

      // Horizontal grid lines (+12dB, +6dB, -6dB, -12dB delta)
      const deltaSteps = [12, 6, -6, -12];
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      deltaSteps.forEach((d) => {
        const y = centerY - (d / 18) * (h * 0.42);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillText(`${d > 0 ? "+" : ""}${d} dB`, w - 8, y + 3);
      });

      // Frequency vertical markings
      const freqMarkers = [50, 150, 500, 1500, 5000, 12000];
      ctx.textAlign = "center";
      freqMarkers.forEach((f) => {
        const x = freqToX(f, w);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(label, x, h - 6);
      });

      if (primAnalyser && primFreqData && refAnalyser && refFreqData) {
        primAnalyser.getByteFrequencyData(primFreqData);
        refAnalyser.getByteFrequencyData(refFreqData);

        const nyquist = 24000;
        const deltas = new Float32Array(numPoints);

        let subSum = 0, subCnt = 0;
        let lowMidSum = 0, lowMidCnt = 0;
        let midSum = 0, midCnt = 0;
        let highMidSum = 0, highMidCnt = 0;
        let airSum = 0, airCnt = 0;

        for (let i = 0; i < numPoints; i++) {
          const freq = freqs[i];
          const primBin = Math.min(
            primFreqData.length - 1,
            Math.round((freq / nyquist) * primFreqData.length)
          );
          const refBin = Math.min(
            refFreqData.length - 1,
            Math.round((freq / nyquist) * refFreqData.length)
          );

          // Scaled dB magnitude difference
          const primVal = primFreqData[primBin] / 255.0;
          const refVal = refFreqData[refBin] / 255.0;
          const diff = (primVal - refVal) * 24.0; // in approximate dB difference
          deltas[i] = diff;

          // Bucket metrics
          if (freq < 80) {
            subSum += diff;
            subCnt++;
          } else if (freq < 400) {
            lowMidSum += diff;
            lowMidCnt++;
          } else if (freq < 2500) {
            midSum += diff;
            midCnt++;
          } else if (freq < 8000) {
            highMidSum += diff;
            highMidCnt++;
          } else {
            airSum += diff;
            airCnt++;
          }
        }

        // Periodically update UI metrics state (every 250ms)
        if (time - lastMetricsTime > 250) {
          lastMetricsTime = time;
          setBandDeltas({
            sub: subCnt > 0 ? Math.round((subSum / subCnt) * 10) / 10 : 0,
            lowMid: lowMidCnt > 0 ? Math.round((lowMidSum / lowMidCnt) * 10) / 10 : 0,
            mid: midCnt > 0 ? Math.round((midSum / midCnt) * 10) / 10 : 0,
            highMid: highMidCnt > 0 ? Math.round((highMidSum / highMidCnt) * 10) / 10 : 0,
            air: airCnt > 0 ? Math.round((airSum / airCnt) * 10) / 10 : 0,
          });
        }

        // Draw Shaded Delta Spectrum Area
        for (let i = 0; i < numPoints - 1; i++) {
          const x1 = freqToX(freqs[i], w);
          const x2 = freqToX(freqs[i + 1], w);
          const diff1 = deltas[i];
          const diff2 = deltas[i + 1];

          const y1 = centerY - (diff1 / 18) * (h * 0.42);
          const y2 = centerY - (diff2 / 18) * (h * 0.42);

          const isExcess = diff1 + diff2 >= 0;

          ctx.beginPath();
          ctx.moveTo(x1, centerY);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x2, centerY);
          ctx.closePath();

          ctx.fillStyle = isExcess ? "rgba(249, 115, 22, 0.35)" : "rgba(56, 189, 248, 0.35)";
          ctx.fill();
        }

        // Draw Delta Line
        ctx.beginPath();
        for (let i = 0; i < numPoints; i++) {
          const x = freqToX(freqs[i], w);
          const y = centerY - (deltas[i] / 18) * (h * 0.42);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Placeholder message when no reference or no playback
        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.textAlign = "center";
        ctx.font = "13px sans-serif";
        ctx.fillText(
          referenceTrack
            ? "Play audio to visualize live spectral comparison & delta"
            : "Select or import a Reference Track (Track B) to begin comparison",
          w / 2,
          centerY - 10
        );
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [getPrimaryAnalyser, getRefAnalyser, referenceTrack]);

  return (
    <div className="audio-comparison-studio">
      {/* Top Header & Track Selector */}
      <div className="comp-header">
        <div className="comp-track-selector">
          <div className={`comp-slot ${activeSource === "primary" ? "active" : ""}`}>
            <span className="slot-badge track-a">TRACK A (TARGET)</span>
            <div className="slot-name" title={primaryTrack?.name}>
              {primaryTrack?.name || "No Track Loaded"}
            </div>
          </div>

          <div className="comp-vs-pill">VS</div>

          <div className={`comp-slot ${activeSource === "reference" ? "active" : ""}`}>
            <span className="slot-badge track-b">TRACK B (REFERENCE)</span>
            <div className="slot-controls">
              <select
                className="comp-ref-select"
                value={referenceTrack?.id ?? ""}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const selected = availableMedia.find((m) => m.id === id) || null;
                  setReferenceTrack(selected);
                }}
              >
                <option value="">choose reference track…</option>
                {availableMedia
                  .filter((m) => m.id !== primaryTrack?.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.musical_key ? `[${m.musical_key}]` : ""}
                    </option>
                  ))}
              </select>

              <button
                type="button"
                className="comp-import-btn"
                onClick={handleImportReference}
                title="Browse audio file from computer"
              >
                + browse file
              </button>
            </div>
          </div>
        </div>

        {/* Big Instant A/B Toggle Switch */}
        {referenceTrack && (
          <div className="comp-ab-switch-group">
            <button
              type="button"
              className={`comp-ab-main-btn ${activeSource === "primary" ? "active" : ""}`}
              onClick={() => setActiveSource("primary")}
            >
              <span className="btn-key">PRESS A</span>
              <span className="btn-label">track a (with eq)</span>
            </button>

            <button
              type="button"
              className={`comp-ab-main-btn ${activeSource === "reference" ? "active" : ""}`}
              onClick={() => setActiveSource("reference")}
            >
              <span className="btn-key">PRESS B</span>
              <span className="btn-label">track b (reference)</span>
            </button>
          </div>
        )}
      </div>

      {/* Synchronized Delta Controls: Loudness matching offset & sync playheads */}
      {referenceTrack && (
        <div className="comp-sync-bar">
          <label className="comp-sync-toggle">
            <input
              type="checkbox"
              checked={syncPlayheads}
              onChange={(e) => setSyncPlayheads(e.target.checked)}
            />
            <span>sync playheads (seamless scrubbing)</span>
          </label>

          <div className="comp-level-match">
            <span className="comp-match-label">ref level trim:</span>
            <input
              type="range"
              min="-12"
              max="12"
              step="0.5"
              value={refVolumeOffset}
              onChange={(e) => setRefVolumeOffset(parseFloat(e.target.value))}
              className="comp-trim-slider"
            />
            <span className="comp-trim-val">
              {refVolumeOffset > 0 ? `+${refVolumeOffset}` : refVolumeOffset} dB
            </span>
          </div>
        </div>
      )}

      {/* Delta Spectrum Canvas */}
      <div className="comp-canvas-section">
        <div className="comp-canvas-heading">
          <span>Real-time Spectral Difference (Track A − Track B)</span>
          <div className="comp-legend">
            <span className="legend-chip excess">
              <span className="dot orange" /> Excess in Track A (+dB)
            </span>
            <span className="legend-chip deficit">
              <span className="dot blue" /> Deficit vs Reference (−dB)
            </span>
          </div>
        </div>

        <canvas
          ref={canvasRef}
          width={720}
          height={240}
          className="comp-delta-canvas"
        />
      </div>

      {/* 5-Band Spectral Delta Meters */}
      {referenceTrack && (
        <div className="comp-delta-meters">
          <div className="delta-meter-card">
            <span className="meter-band">Sub Bass (&lt;80Hz)</span>
            <span
              className={`meter-val ${bandDeltas.sub > 1 ? "excess" : bandDeltas.sub < -1 ? "deficit" : "match"}`}
            >
              {bandDeltas.sub > 0 ? `+${bandDeltas.sub}` : bandDeltas.sub} dB
            </span>
            <span className="meter-desc">
              {bandDeltas.sub > 1.5 ? "Too Heavy" : bandDeltas.sub < -1.5 ? "Lacks Sub" : "Balanced"}
            </span>
          </div>

          <div className="delta-meter-card">
            <span className="meter-band">Low Mid (80-400Hz)</span>
            <span
              className={`meter-val ${bandDeltas.lowMid > 1 ? "excess" : bandDeltas.lowMid < -1 ? "deficit" : "match"}`}
            >
              {bandDeltas.lowMid > 0 ? `+${bandDeltas.lowMid}` : bandDeltas.lowMid} dB
            </span>
            <span className="meter-desc">
              {bandDeltas.lowMid > 1.5 ? "Boxy / Muddy" : bandDeltas.lowMid < -1.5 ? "Thin Lows" : "Clean"}
            </span>
          </div>

          <div className="delta-meter-card">
            <span className="meter-band">Midrange (400-2.5kHz)</span>
            <span
              className={`meter-val ${bandDeltas.mid > 1 ? "excess" : bandDeltas.mid < -1 ? "deficit" : "match"}`}
            >
              {bandDeltas.mid > 0 ? `+${bandDeltas.mid}` : bandDeltas.mid} dB
            </span>
            <span className="meter-desc">
              {bandDeltas.mid > 1.5 ? "Harsh Mids" : bandDeltas.mid < -1.5 ? "Scooped" : "Natural"}
            </span>
          </div>

          <div className="delta-meter-card">
            <span className="meter-band">High Mid (2.5k-8kHz)</span>
            <span
              className={`meter-val ${bandDeltas.highMid > 1 ? "excess" : bandDeltas.highMid < -1 ? "deficit" : "match"}`}
            >
              {bandDeltas.highMid > 0 ? `+${bandDeltas.highMid}` : bandDeltas.highMid} dB
            </span>
            <span className="meter-desc">
              {bandDeltas.highMid > 1.5 ? "Sibilant / Sharp" : bandDeltas.highMid < -1.5 ? "Dull" : "Crisp"}
            </span>
          </div>

          <div className="delta-meter-card">
            <span className="meter-band">Air (&gt;8kHz)</span>
            <span
              className={`meter-val ${bandDeltas.air > 1 ? "excess" : bandDeltas.air < -1 ? "deficit" : "match"}`}
            >
              {bandDeltas.air > 0 ? `+${bandDeltas.air}` : bandDeltas.air} dB
            </span>
            <span className="meter-desc">
              {bandDeltas.air > 1.5 ? "Bright" : bandDeltas.air < -1.5 ? "Needs Air" : "Silky"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
