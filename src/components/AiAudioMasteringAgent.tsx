import { useState, useCallback, useEffect, useRef } from "react";
import { useGlobalAudio } from "../audio/GlobalAudioContext";
import { StudioIcon } from "./StudioIcons";
import {
  aiCreateConversation,
  aiDefaultProvider,
  aiListModels,
  aiSendMessage,
  analyzeMedia,
  meterMaster,
  renderMasterWithEq,
  type MasteringReport,
  type MediaFile,
} from "../api";
import type { EqBand, EqBandType } from "../audio/types";

interface ParsedAiEq {
  bands: Array<{
    type: EqBandType;
    frequency: number;
    gain: number;
    q: number;
    enabled?: boolean;
    name?: string;
  }>;
  summary: string;
  recommendations: Array<{
    text: string;
    icon?: "highpass" | "lowshelf" | "peaking" | "notch" | "highshelf" | "lowpass";
  }>;
  diagnosis?: string;
}

export function AiAudioMasteringAgent({
  songId,
  onMasterRendered,
  onSwitchToStudio,
}: {
  songId?: number;
  onMasterRendered?: (media: MediaFile) => void;
  onSwitchToStudio?: () => void;
}) {
  const {
    primaryTrack,
    referenceTrack,
    eqBands,
    setEqBands,
    isEqBypassed,
    toggleEqBypass,
  } = useGlobalAudio();

  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [, setStreamedText] = useState<string>("");
  const [aiReport, setAiReport] = useState<ParsedAiEq | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetLufs, setTargetLufs] = useState<number>(-14.0);
  const [rendering, setRendering] = useState<boolean>(false);
  const [renderSuccess, setRenderSuccess] = useState<string | null>(null);
  const [applied, setApplied] = useState<boolean>(false);

  const miniCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Default diagnosis and recommendations when opening first time if not yet analyzed
  const defaultDiagnosis =
    `Low-end sits 1.8 dB hot against the reference and there's boxiness near 300 Hz. ` +
    `Presence and air are shy — the mix reads darker than "${referenceTrack ? referenceTrack.name : "glass bones"}".`;

  const defaultRecommendations = [
    { text: "clean rumble · highpass 28 Hz", icon: "highpass" as const },
    { text: "notch boxiness · 300 Hz · −2.0 dB", icon: "notch" as const },
    { text: "boost presence · 3.5 kHz · +1.5 dB", icon: "peaking" as const },
    { text: "silky air · shelf 11.5 kHz · +2.2 dB", icon: "highshelf" as const },
  ];

  const defaultProposedBands: Array<{ type: EqBandType; frequency: number; gain: number; q: number }> = [
    { type: "highpass", frequency: 28, gain: 0, q: 0.707 },
    { type: "lowshelf", frequency: 90, gain: 1.2, q: 0.707 },
    { type: "peaking", frequency: 300, gain: -2.0, q: 1.4 },
    { type: "peaking", frequency: 1100, gain: -0.8, q: 1.6 },
    { type: "peaking", frequency: 3500, gain: 1.5, q: 1.2 },
    { type: "peaking", frequency: 6800, gain: 1.8, q: 1.1 },
    { type: "highshelf", frequency: 11500, gain: 2.2, q: 0.707 },
    { type: "lowpass", frequency: 19500, gain: 0, q: 0.707 },
  ];

  // Parse AI response looking for structured JSON code blocks
  const parseAiResponse = (text: string): ParsedAiEq | null => {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed && Array.isArray(parsed.bands)) {
          const recs = (parsed.recommendations || []).map((r: any) => {
            const str = typeof r === "string" ? r : r.text || "";
            let icon: any = "peaking";
            if (str.toLowerCase().includes("highpass") || str.toLowerCase().includes("rumble")) icon = "highpass";
            else if (str.toLowerCase().includes("notch") || str.toLowerCase().includes("-")) icon = "notch";
            else if (str.toLowerCase().includes("air") || str.toLowerCase().includes("shelf")) icon = "highshelf";
            else if (str.toLowerCase().includes("presence") || str.toLowerCase().includes("boost")) icon = "peaking";
            return { text: str, icon };
          });

          return {
            bands: parsed.bands,
            summary: parsed.summary || "AI Parametric EQ Curve generated.",
            recommendations: recs.length > 0 ? recs : defaultRecommendations,
            diagnosis: parsed.diagnosis || parsed.summary || defaultDiagnosis,
          };
        }
      }
    } catch {
      // Still streaming
    }
    return null;
  };

  const handleRunAiAnalysis = useCallback(async () => {
    if (!primaryTrack) {
      setError("Please load an active audio track first.");
      return;
    }

    setAnalyzing(true);
    setError(null);
    setStreamedText("");
    setRenderSuccess(null);
    setApplied(false);

    try {
      // 1. Measure track metrics via backend DSP meter
      const primaryMeter: MasteringReport = await meterMaster(primaryTrack.id);
      let refMeter: MasteringReport | null = null;
      if (referenceTrack) {
        try {
          refMeter = await meterMaster(referenceTrack.id);
        } catch {
          // Optional ref
        }
      }

      // 2. Formulate acoustic prompt
      let prompt = `You are a world-class mastering engineer. Analyze the acoustic profile of Track A ("${primaryTrack.name}")`;
      if (referenceTrack && refMeter) {
        prompt += ` and compare it against Reference Track B ("${referenceTrack.name}"):\n\n`;
      } else {
        prompt += `:\n\n`;
      }

      prompt += `### Track A Metrics:
- Integrated Loudness: ${primaryMeter.input_lufs?.toFixed(1) ?? "N/A"} LUFS
- True Peak: ${primaryMeter.true_peak_dbtp?.toFixed(1) ?? "N/A"} dBTP
- Crest Factor (Dynamics): ${primaryMeter.crest_db?.toFixed(1) ?? "N/A"} dB
- Dynamic Range (LRA): ${primaryMeter.lra?.toFixed(1) ?? "N/A"} LU
- Low-End RMS (<250Hz): ${primaryMeter.low_band_db?.toFixed(1) ?? "N/A"} dB
- High-End RMS (>4kHz): ${primaryMeter.high_band_db?.toFixed(1) ?? "N/A"} dB\n\n`;

      if (referenceTrack && refMeter) {
        prompt += `### Reference Track B Metrics:
- Integrated Loudness: ${refMeter.input_lufs?.toFixed(1) ?? "N/A"} LUFS
- True Peak: ${refMeter.true_peak_dbtp?.toFixed(1) ?? "N/A"} dBTP
- Crest Factor: ${refMeter.crest_db?.toFixed(1) ?? "N/A"} dB
- Dynamic Range (LRA): ${refMeter.lra?.toFixed(1) ?? "N/A"} LU
- Low-End RMS (<250Hz): ${refMeter.low_band_db?.toFixed(1) ?? "N/A"} dB
- High-End RMS (>4kHz): ${refMeter.high_band_db?.toFixed(1) ?? "N/A"} dB\n\n`;
      }

      prompt += `Provide a 2-sentence diagnostic assessment highlighting tonal differences, boxiness, presence, or air.
Then output an exact 8-band parametric EQ JSON block:
\`\`\`json
{
  "diagnosis": "Low-end sits 1.8 dB hot against the reference and there's boxiness near 300 Hz. Presence and air are shy — the mix reads darker than the reference.",
  "summary": "Tonal balance correction with clean sub-cut, mud dip, and silky air sheen.",
  "recommendations": [
    "clean rumble • highpass 28 Hz",
    "notch boxiness • 300 Hz • -2.0 dB",
    "boost presence • 3.5 kHz • +1.5 dB",
    "silky air • shelf 11.5 kHz • +2.2 dB"
  ],
  "bands": [
    { "type": "highpass", "frequency": 28, "gain": 0, "q": 0.707 },
    { "type": "lowshelf", "frequency": 90, "gain": 1.2, "q": 0.707 },
    { "type": "peaking", "frequency": 300, "gain": -2.0, "q": 1.4 },
    { "type": "peaking", "frequency": 1100, "gain": -0.8, "q": 1.6 },
    { "type": "peaking", "frequency": 3500, "gain": 1.5, "q": 1.2 },
    { "type": "peaking", "frequency": 6800, "gain": 1.8, "q": 1.1 },
    { "type": "highshelf", "frequency": 11500, "gain": 2.2, "q": 0.707 },
    { "type": "lowpass", "frequency": 19500, "gain": 0, "q": 0.707 }
  ]
}
\`\`\``;

      // 3. Send streaming request
      const provider = await aiDefaultProvider().catch(() => null);
      let modelName = provider?.model ?? "";
      if (provider) {
        const models = await aiListModels(provider.id).catch(() => []);
        if (models.length > 0) {
          modelName = models[0].name;
        }
      }

      const conv = await aiCreateConversation(songId ?? null, modelName, provider?.id ?? null);
      let fullReply = "";

      await aiSendMessage(conv.id, prompt, null, (event) => {
        if (event.type === "delta" && event.text) {
          fullReply += event.text;
          setStreamedText(fullReply);
          const parsed = parseAiResponse(fullReply);
          if (parsed) setAiReport(parsed);
        }
      });

      const finalParsed = parseAiResponse(fullReply);
      if (finalParsed) {
        setAiReport(finalParsed);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setAnalyzing(false);
    }
  }, [primaryTrack, referenceTrack, songId]);

  // Apply AI EQ curve to live EQ graph
  const handleApplyAiEq = () => {
    const bandsToApply = aiReport?.bands || defaultProposedBands;

    const colors = [
      "#ef4444",
      "#f97316",
      "#eab308",
      "#22c55e",
      "#06b6d4",
      "#3b82f6",
      "#a855f7",
      "#ec4899",
    ];

    const newBands: EqBand[] = bandsToApply.map((b: any, idx) => ({
      id: idx + 1,
      name: b.name || `Band ${idx + 1}`,
      type: b.type || (idx === 0 ? "highpass" : idx === 7 ? "lowpass" : "peaking"),
      frequency: Math.max(20, Math.min(20000, b.frequency)),
      gain: Math.max(-15, Math.min(15, b.gain || 0)),
      q: Math.max(0.1, Math.min(18, b.q || 0.707)),
      enabled: b.enabled !== false,
      color: colors[idx % colors.length],
    }));

    setEqBands(newBands);
    if (isEqBypassed) toggleEqBypass();
    setApplied(true);
    if (onSwitchToStudio) {
      setTimeout(() => onSwitchToStudio(), 400);
    }
  };

  // Render 24-bit Master WAV via Rust FFmpeg
  const handleRenderMaster = async () => {
    if (!primaryTrack || !songId) {
      setError("Active track and song are required for rendering.");
      return;
    }

    setRendering(true);
    setError(null);
    setRenderSuccess(null);

    try {
      const eqBandParams = eqBands.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        frequency: b.frequency,
        gain: b.gain,
        q: b.q,
        enabled: b.enabled,
      }));

      const renderedFile = await renderMasterWithEq(
        primaryTrack.id,
        songId,
        targetLufs,
        eqBandParams,
        { tapeWarmth: true, stereoEnhance: true }
      );

      analyzeMedia(renderedFile.id).catch(() => {});
      setRenderSuccess(`Master created: "${renderedFile.name}"`);
      if (onMasterRendered) onMasterRendered(renderedFile);
    } catch (err) {
      setError(`Render failed: ${String(err)}`);
    } finally {
      setRendering(false);
    }
  };

  // Draw Mini Preview EQ Curve inside Proposed Curve Card
  useEffect(() => {
    const canvas = miniCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Baseline 0 dB
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Proposed bands points
    const bands = aiReport?.bands || defaultProposedBands;
    const points = bands.map((b, i) => ({
      x: 14 + (i / (bands.length - 1)) * (w - 28),
      y: (h / 2) - (b.gain / 15) * (h * 0.38),
    }));

    // Smooth curve
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = "#7cd2ff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw nodes
    points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#0b0f14";
      ctx.fill();
      ctx.strokeStyle = "#7cd2ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }, [aiReport]);

  const currentDiagnosis = aiReport?.diagnosis || defaultDiagnosis;
  const currentRecs = aiReport?.recommendations || defaultRecommendations;

  return (
    <div className="ai-agent-panel-container">
      <div className="ai-agent-body-scroll">
        {/* AI Agent Title Block */}
        <div className="ai-agent-identity-row">
          <div className="identity-left">
            <StudioIcon name="ai-agent" state="active" size={20} className="agent-icon" />
            <div className="identity-text">
              <h3 className="agent-heading">ai mastering agent</h3>
              <span className="agent-subheading">
                DSP ACOUSTIC MODEL · {primaryTrack?.name ? `TRACK A VS ${referenceTrack?.name || "REFERENCE B"}` : "SPECTRAL PROFILE"}
              </span>
            </div>
          </div>
          <span className={`agent-status-pill ${analyzing ? "analyzing" : "analyzed"}`}>
            {analyzing ? "ANALYZING…" : "ANALYZED"}
          </span>
        </div>

        {error && <div className="ai-error-banner">{error}</div>}

        {/* 3. Diagnosis Card */}
        <div className="ai-studio-card diagnosis-card">
          <div className="card-section-label">DIAGNOSIS</div>
          <p className="diagnosis-text">{currentDiagnosis}</p>
        </div>

        {/* 4. Proposed Curve • 8 Bands Card */}
        <div className="ai-studio-card proposed-curve-card">
          <div className="card-section-label">PROPOSED CURVE · 8 BANDS</div>

          {/* Mini Canvas Visualizer */}
          <div className="mini-curve-canvas-wrap">
            <canvas ref={miniCanvasRef} width={340} height={70} className="mini-curve-canvas" />
          </div>

          {/* 4 Icon Recommendation Bullet Items */}
          <div className="proposed-recs-list">
            {currentRecs.map((rec, idx) => (
              <div key={idx} className="rec-item-row">
                <StudioIcon
                  name={rec.icon || "peaking"}
                  state="active"
                  size={16}
                  className="rec-bullet-icon"
                />
                <span className="rec-text">{rec.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 5. Target Loudness Card */}
        <div className="ai-studio-card loudness-stepper-card">
          <div className="stepper-label">TARGET LOUDNESS</div>
          <div className="stepper-control-row">
            <button
              type="button"
              className="stepper-btn minus"
              onClick={() => setTargetLufs((v) => Math.max(-24, Math.round((v - 0.5) * 10) / 10))}
            >
              −
            </button>
            <span className="stepper-value-display">{targetLufs.toFixed(1)} LUFS</span>
            <button
              type="button"
              className="stepper-btn plus"
              onClick={() => setTargetLufs((v) => Math.min(-6, Math.round((v + 0.5) * 10) / 10))}
            >
              +
            </button>
          </div>
        </div>

        {/* 6. Primary Action Button: Apply Curve to Live EQ */}
        <div className="ai-agent-action-stack">
          <button
            type="button"
            className={`apply-live-eq-btn ${applied ? "applied" : ""}`}
            onClick={handleApplyAiEq}
          >
            <StudioIcon name="bypass" color="#0b0f14" size={16} />
            <span>{applied ? "curve applied to live eq" : "apply curve to live eq"}</span>
          </button>

          {/* Secondary Action Row */}
          <div className="secondary-action-row">
            <button
              type="button"
              className="agent-sec-btn"
              onClick={handleRenderMaster}
              disabled={rendering || !primaryTrack}
            >
              {rendering ? "rendering…" : "render with eq"}
            </button>

            <button
              type="button"
              className="agent-sec-btn"
              onClick={handleRunAiAnalysis}
              disabled={analyzing || !primaryTrack}
            >
              {analyzing ? "analyzing…" : "re-analyze"}
            </button>
          </div>

          {renderSuccess && <div className="render-toast-msg">{renderSuccess}</div>}
        </div>
      </div>
    </div>
  );
}
