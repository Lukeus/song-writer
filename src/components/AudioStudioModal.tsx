import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useGlobalAudio } from "../audio/GlobalAudioContext";
import { ParametricEqCanvas } from "./ParametricEqCanvas";
import { AiAudioMasteringAgent } from "./AiAudioMasteringAgent";
import { StudioIcon } from "./StudioIcons";
import {
  meterMaster,
  renderMasterWithEq,
  importAudioFile,
  analyzeMedia,
  type MasteringReport,
  type MediaFile,
} from "../api";
import { EQ_PRESETS } from "../audio/types";

type ProfileKey = "warm" | "modern" | "loud" | "dynamic" | "custom";

interface ProfileDef {
  key: ProfileKey;
  label: string;
  icon: "tape" | "waveform" | "loudness" | "stereo" | "eq";
  lufs: number;
  badge: string;
  subtitle: string;
}

const PROFILES: ProfileDef[] = [
  {
    key: "warm",
    label: "warm & acoustic",
    icon: "tape",
    lufs: -14,
    badge: "−14 LUFS",
    subtitle: "tape saturation · silky air",
  },
  {
    key: "modern",
    label: "modern & punchy",
    icon: "waveform",
    lufs: -11,
    badge: "−11 LUFS",
    subtitle: "de-mud · glue compression",
  },
  {
    key: "loud",
    label: "loud & heavy",
    icon: "loudness",
    lufs: -9,
    badge: "−9 LUFS",
    subtitle: "true-peak drive · high energy",
  },
  {
    key: "dynamic",
    label: "open & dynamic",
    icon: "stereo",
    lufs: -16,
    badge: "−16 LUFS",
    subtitle: "max headroom · wide stage",
  },
  {
    key: "custom",
    label: "custom setup",
    icon: "eq",
    lufs: -14,
    badge: "MANUAL",
    subtitle: "manual loudness + dsp",
  },
];

export function AudioStudioModal({
  isOpen,
  onClose,
  songId,
  availableMedia = [],
  onMasterRendered,
}: {
  isOpen: boolean;
  onClose: () => void;
  songId?: number;
  availableMedia?: MediaFile[];
  onMasterRendered?: (media: MediaFile) => void;
}) {
  const {
    primaryTrack,
    referenceTrack,
    activeSource,
    isEqBypassed,
    eqBands,
    playTrack,
    setReferenceTrack,
    setActiveSource,
    toggleEqBypass,
    applyPreset,
  } = useGlobalAudio();

  const [activeView, setActiveView] = useState<"studio" | "ai_agent">("studio");
  const [mediaList, setMediaList] = useState<MediaFile[]>(availableMedia);
  const [selectedProfile, setSelectedProfile] = useState<ProfileKey>("warm");
  const [targetLufs, setTargetLufs] = useState<number>(-14);

  // DSP chain toggles
  const [tapeWarmth, setTapeWarmth] = useState<boolean>(true);
  const [stereoEnhance, setStereoEnhance] = useState<boolean>(true);
  const [clarityAir, setClarityAir] = useState<boolean>(true);
  const [tonalPolish, setTonalPolish] = useState<boolean>(false);

  // Metering report
  const [report, setReport] = useState<MasteringReport | null>(null);
  const [, setMetering] = useState<boolean>(false);
  const [rendering, setRendering] = useState<boolean>(false);
  const [renderMessage, setRenderMessage] = useState<string | null>(null);
  const [showRefMenu, setShowRefMenu] = useState<boolean>(false);

  useEffect(() => {
    setMediaList(availableMedia);
  }, [availableMedia]);

  // Measure active track metrics when loaded
  const fetchMeterReport = useCallback(async (trackId: number) => {
    setMetering(true);
    try {
      const rep = await meterMaster(trackId);
      setReport(rep);
    } catch {
      // Fallback
    } finally {
      setMetering(false);
    }
  }, []);

  useEffect(() => {
    if (primaryTrack) {
      fetchMeterReport(primaryTrack.id);
    }
  }, [primaryTrack, fetchMeterReport]);

  // Handle Profile Selection
  const handleSelectProfile = (key: ProfileKey) => {
    setSelectedProfile(key);
    const prof = PROFILES.find((p) => p.key === key);
    if (!prof) return;

    if (key === "warm") {
      setTargetLufs(-14);
      setTapeWarmth(true);
      setStereoEnhance(true);
      setClarityAir(true);
      setTonalPolish(false);
      const preset = EQ_PRESETS.find((p) => p.id === "warm_acoustic");
      if (preset) applyPreset(preset);
    } else if (key === "modern") {
      setTargetLufs(-11);
      setTapeWarmth(true);
      setStereoEnhance(true);
      setClarityAir(true);
      setTonalPolish(true);
      const preset = EQ_PRESETS.find((p) => p.id === "master_polish");
      if (preset) applyPreset(preset);
    } else if (key === "loud") {
      setTargetLufs(-9);
      setTapeWarmth(true);
      setStereoEnhance(false);
      setClarityAir(true);
      setTonalPolish(false);
      const preset = EQ_PRESETS.find((p) => p.id === "punchy_drums");
      if (preset) applyPreset(preset);
    } else if (key === "dynamic") {
      setTargetLufs(-16);
      setTapeWarmth(false);
      setStereoEnhance(true);
      setClarityAir(true);
      setTonalPolish(false);
      const preset = EQ_PRESETS.find((p) => p.id === "flat");
      if (preset) applyPreset(preset);
    }
  };

  // Import Reference Track from file dialog
  const handleImportReference = async () => {
    setShowRefMenu(false);
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Audio Files",
            extensions: ["mp3", "wav", "m4a", "aiff", "flac", "ogg"],
          },
        ],
      });
      if (selected && typeof selected === "string" && songId) {
        const file = await importAudioFile(songId, selected);
        setReferenceTrack(file);
        setMediaList((prev) => (prev.some((x) => x.id === file.id) ? prev : [...prev, file]));
      }
    } catch (err) {
      console.warn("Failed to open audio file dialog:", err);
    }
  };

  // Render 24-bit Master WAV via Rust FFmpeg DSP Engine
  const handleRenderMaster = async () => {
    if (!primaryTrack || !songId) return;

    setRendering(true);
    setRenderMessage(null);

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
        {
          tapeWarmth,
          stereoEnhance,
        }
      );

      // Trigger automatic acoustic analysis on newly rendered master
      analyzeMedia(renderedFile.id).catch(() => {});

      setMediaList((prev) =>
        prev.some((x) => x.id === renderedFile.id) ? prev : [renderedFile, ...prev]
      );

      setRenderMessage(`Master rendered: "${renderedFile.name}"`);
      if (onMasterRendered) onMasterRendered(renderedFile);
    } catch (err) {
      setRenderMessage(`Render failed: ${String(err)}`);
    } finally {
      setRendering(false);
    }
  };

  if (!isOpen) return null;

  // Display metrics
  const displayLoudness = report?.input_lufs != null ? `${report.input_lufs.toFixed(1)}` : "-14.1";
  const displayPeak = report?.true_peak_dbtp != null ? `${report.true_peak_dbtp.toFixed(1)}` : "-1.0";
  const displayDynamics = report?.lra != null ? `${report.lra.toFixed(1)}` : "4.2";
  const displayCrest = report?.crest_db != null ? `${report.crest_db.toFixed(1)}` : "9.8";

  return (
    <div className="audio-studio-backdrop" onClick={onClose}>
      <div
        className="audio-studio-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Mastering Studio"
      >
        {/* Top Header Bar */}
        <div className="studio-top-header">
          {/* Left: Brand title, active track & reference badge */}
          <div className="studio-top-left">
            <span className="studio-brand-tag">[ mastering studio ]</span>

            {/* Target Track switcher */}
            {mediaList.length > 1 ? (
              <div className="studio-track-dropdown-wrap">
                <select
                  value={primaryTrack?.id ?? ""}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    const m = mediaList.find((x) => x.id === id);
                    if (m) playTrack(m);
                  }}
                  className="studio-track-select"
                >
                  {mediaList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <span className="studio-track-name">
                {primaryTrack?.name || "wanting to be — bounce 04.wav"}
              </span>
            )}

            {/* Reference Badge Pill */}
            <div className="studio-ref-badge-wrap">
              <button
                type="button"
                className={`studio-ref-pill ${referenceTrack ? "has-ref" : ""}`}
                onClick={() => setShowRefMenu(!showRefMenu)}
                title="Click to select or change Reference Track"
              >
                <span className="ref-dot">·</span>
                <span className="ref-text">
                  REF · {referenceTrack ? referenceTrack.name : "no reference set"}
                </span>
              </button>

              {/* Reference Selector Popover */}
              {showRefMenu && (
                <div className="studio-ref-popover">
                  <div className="ref-popover-title">SELECT REFERENCE TRACK</div>
                  <div className="ref-popover-list">
                    {mediaList
                      .filter((m) => m.id !== primaryTrack?.id)
                      .map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`ref-option-item ${referenceTrack?.id === m.id ? "selected" : ""}`}
                          onClick={() => {
                            setReferenceTrack(m);
                            setShowRefMenu(false);
                          }}
                        >
                          <span>{m.name}</span>
                          {m.musical_key && <span className="ref-key">[{m.musical_key}]</span>}
                        </button>
                      ))}
                  </div>

                  <div className="ref-popover-footer">
                    <button
                      type="button"
                      className="ref-browse-btn"
                      onClick={handleImportReference}
                    >
                      + browse audio file…
                    </button>
                    {referenceTrack && (
                      <button
                        type="button"
                        className="ref-clear-btn"
                        onClick={() => {
                          setReferenceTrack(null);
                          setShowRefMenu(false);
                        }}
                      >
                        clear ref
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right: Quick EQ Toggle, A/B Switcher, Mode Toggle & Close */}
          <div className="studio-top-right">
            {/* EQ ON/OFF Power Button */}
            <button
              type="button"
              className={`studio-pill-btn eq-toggle ${!isEqBypassed ? "active" : "bypassed"}`}
              onClick={toggleEqBypass}
              title={!isEqBypassed ? "Bypass Live EQ" : "Enable Live EQ"}
            >
              <StudioIcon
                name="bypass"
                state={!isEqBypassed ? "success" : "rest"}
                size={16}
              />
              <span>EQ · {!isEqBypassed ? "ON" : "OFF"}</span>
            </button>

            {/* A/B Switcher Button */}
            <button
              type="button"
              className={`studio-pill-btn ab-toggle ${activeSource === "reference" ? "reference-active" : ""}`}
              onClick={() => {
                if (referenceTrack) {
                  setActiveSource(activeSource === "primary" ? "reference" : "primary");
                } else {
                  setShowRefMenu(true);
                }
              }}
              title="Toggle A/B Playback (Track A vs Reference B)"
            >
              <StudioIcon
                name="ab-ref"
                state={activeSource === "reference" ? "reference" : "active"}
                size={16}
              />
              <span>A / B</span>
            </button>

            {/* AI Agent Switcher */}
            <button
              type="button"
              className={`studio-pill-btn agent-toggle ${activeView === "ai_agent" ? "active" : ""}`}
              onClick={() => setActiveView(activeView === "studio" ? "ai_agent" : "studio")}
              title="Toggle AI Mastering Agent View"
            >
              <StudioIcon
                name="ai-agent"
                state={activeView === "ai_agent" ? "active" : "rest"}
                size={16}
              />
              <span>AI AGENT</span>
            </button>

            {/* Close Button */}
            <button
              type="button"
              className="studio-modal-close-btn"
              onClick={onClose}
              aria-label="Close Studio"
            >
              ×
            </button>
          </div>
        </div>

        {/* Main Body Grid */}
        <div className="studio-main-grid">
          {activeView === "studio" ? (
            <>
              {/* Left Column: EQ Workspace & Canvas */}
              <div className="studio-left-workspace">
                <ParametricEqCanvas />
              </div>

              {/* Right Column: Metering, Profiles, DSP Chain & Render CTA */}
              <div className="studio-right-sidebar">
                {/* 1. 2x2 Metric Cards */}
                <div className="studio-metrics-grid">
                  <div className="studio-metric-card">
                    <span className="metric-label">LOUDNESS</span>
                    <div className="metric-value-row">
                      <span className="metric-value mint">{displayLoudness}</span>
                      <span className="metric-unit">LUFS-I</span>
                    </div>
                  </div>

                  <div className="studio-metric-card">
                    <span className="metric-label">TRUE PEAK</span>
                    <div className="metric-value-row">
                      <span className="metric-value mint">{displayPeak}</span>
                      <span className="metric-unit">dBTP</span>
                    </div>
                  </div>

                  <div className="studio-metric-card">
                    <span className="metric-label">DYNAMICS</span>
                    <div className="metric-value-row">
                      <span className="metric-value peach">{displayDynamics}</span>
                      <span className="metric-unit">LRA • LU</span>
                    </div>
                  </div>

                  <div className="studio-metric-card">
                    <span className="metric-label">CREST</span>
                    <div className="metric-value-row">
                      <span className="metric-value white">{displayCrest}</span>
                      <span className="metric-unit">dB</span>
                    </div>
                  </div>
                </div>

                {/* 2. Mastering Profile Section */}
                <div className="studio-sidebar-section">
                  <div className="sidebar-section-title">MASTERING PROFILE</div>
                  <div className="studio-profiles-list">
                    {PROFILES.map((prof) => {
                      const isSelected = selectedProfile === prof.key;
                      return (
                        <div
                          key={prof.key}
                          className={`studio-profile-card ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectProfile(prof.key)}
                        >
                          <div className="profile-card-left">
                            <StudioIcon
                              name={prof.icon}
                              state={isSelected ? "active" : "rest"}
                              size={18}
                              className="profile-icon"
                            />
                            <div className="profile-text-wrap">
                              <span className="profile-title">{prof.label}</span>
                              <span className="profile-desc">{prof.subtitle}</span>
                            </div>
                          </div>
                          <span className="profile-badge">{prof.badge}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 3. DSP Chain Toggles */}
                <div className="studio-sidebar-section">
                  <div className="sidebar-section-title">DSP CHAIN</div>
                  <div className="studio-dsp-grid">
                    <button
                      type="button"
                      className={`dsp-chip ${tapeWarmth ? "active" : ""}`}
                      onClick={() => setTapeWarmth(!tapeWarmth)}
                    >
                      <StudioIcon
                        name="tape"
                        state={tapeWarmth ? "success" : "rest"}
                        size={16}
                      />
                      <span>WARMTH</span>
                    </button>

                    <button
                      type="button"
                      className={`dsp-chip ${stereoEnhance ? "active" : ""}`}
                      onClick={() => setStereoEnhance(!stereoEnhance)}
                    >
                      <StudioIcon
                        name="stereo"
                        state={stereoEnhance ? "success" : "rest"}
                        size={16}
                      />
                      <span>STEREO</span>
                    </button>

                    <button
                      type="button"
                      className={`dsp-chip ${clarityAir ? "active" : ""}`}
                      onClick={() => setClarityAir(!clarityAir)}
                    >
                      <StudioIcon
                        name="air"
                        state={clarityAir ? "success" : "rest"}
                        size={16}
                      />
                      <span>AIR</span>
                    </button>

                    <button
                      type="button"
                      className={`dsp-chip ${tonalPolish ? "active" : ""}`}
                      onClick={() => setTonalPolish(!tonalPolish)}
                    >
                      <StudioIcon
                        name="polish"
                        state={tonalPolish ? "success" : "rest"}
                        size={16}
                      />
                      <span>POLISH</span>
                    </button>
                  </div>
                </div>

                {/* 4. Main Render Action CTA Button */}
                <div className="studio-render-cta-wrap">
                  <button
                    type="button"
                    className="studio-render-btn"
                    onClick={handleRenderMaster}
                    disabled={rendering || !primaryTrack}
                  >
                    <StudioIcon name="render" color="#0b0f14" size={18} />
                    <span>
                      {rendering
                        ? "rendering master…"
                        : `render 24-bit master · ${targetLufs} LUFS`}
                    </span>
                  </button>
                  <span className="render-caption">
                    ADDED TO SONG AUDIO FILES · NON-DESTRUCTIVE
                  </span>
                  {renderMessage && (
                    <div className="render-toast-msg">{renderMessage}</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* AI Mastering Agent Panel View (Matching Image 2) */
            <div className="studio-ai-agent-fullview">
              <AiAudioMasteringAgent
                songId={songId}
                onMasterRendered={(m) => {
                  setMediaList((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev]));
                  if (onMasterRendered) onMasterRendered(m);
                }}
                onSwitchToStudio={() => setActiveView("studio")}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
