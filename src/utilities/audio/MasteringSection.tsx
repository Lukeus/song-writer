import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { StudioIcon } from "../../components/StudioIcons";
import {
  meterMaster,
  renderMaster,
  type MasteringOptions,
  type MasteringReport,
  type MediaFile,
} from "../../api";

interface Props {
  media: MediaFile;
  songId: number;
  /** Called with the newly rendered master so the list can refresh. */
  onRendered: (master: MediaFile) => void;
}

type ProfileKey = "warm" | "modern" | "loud" | "dynamic" | "custom";

interface ProfileDef {
  key: ProfileKey;
  label: string;
  icon: "tape" | "waveform" | "loudness" | "stereo" | "eq";
  lufs: number;
  badge: string;
  description: string;
}

const PROFILES: ProfileDef[] = [
  {
    key: "warm",
    label: "warm & acoustic",
    icon: "tape",
    lufs: -14,
    badge: "−14 LUFS",
    description: "tape saturation • silky air sheen",
  },
  {
    key: "modern",
    label: "modern & punchy",
    icon: "waveform",
    lufs: -11,
    badge: "−11 LUFS",
    description: "de-mud notch • glue compression",
  },
  {
    key: "loud",
    label: "loud & heavy",
    icon: "loudness",
    lufs: -9,
    badge: "−9 LUFS",
    description: "high-energy true-peak drive",
  },
  {
    key: "dynamic",
    label: "open & dynamic",
    icon: "stereo",
    lufs: -16,
    badge: "−16 LUFS",
    description: "max headroom • wide 3D stage",
  },
  {
    key: "custom",
    label: "custom setup",
    icon: "eq",
    lufs: -14,
    badge: "MANUAL",
    description: "manual loudness + dsp",
  },
];

/** Professional mastering controls: multi-band DSP, character profiles, recommendations, and 24-bit rendering. */
export function MasteringSection({ media, songId, onRendered }: Props) {
  const [report, setReport] = useState<MasteringReport | null>(null);
  const [metering, setMetering] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mastering profile & DSP toggles
  const [selectedProfile, setSelectedProfile] = useState<ProfileKey>("warm");
  const [customLufs, setCustomLufs] = useState(-14);
  const [tonalPolish, setTonalPolish] = useState(true);
  const [tapeWarmth, setTapeWarmth] = useState(true);
  const [stereoEnhance, setStereoEnhance] = useState(true);
  const [clarityAir, setClarityAir] = useState(true);

  const [done, setDone] = useState<string | null>(null);
  const [renderedMaster, setRenderedMaster] = useState<MediaFile | null>(null);

  // Auto-measure when section opens
  useEffect(() => {
    let cancelled = false;
    setMetering(true);
    setError(null);
    meterMaster(media.id)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setMetering(false));
    return () => {
      cancelled = true;
    };
  }, [media.id]);

  const handleProfileSelect = (key: ProfileKey) => {
    setSelectedProfile(key);
    if (key === "warm") {
      setCustomLufs(-14);
      setTonalPolish(true);
      setTapeWarmth(true);
      setStereoEnhance(true);
      setClarityAir(true);
    } else if (key === "modern") {
      setCustomLufs(-11);
      setTonalPolish(true);
      setTapeWarmth(true);
      setStereoEnhance(true);
      setClarityAir(true);
    } else if (key === "loud") {
      setCustomLufs(-9);
      setTonalPolish(false);
      setTapeWarmth(true);
      setStereoEnhance(false);
      setClarityAir(true);
    } else if (key === "dynamic") {
      setCustomLufs(-16);
      setTonalPolish(false);
      setTapeWarmth(false);
      setStereoEnhance(true);
      setClarityAir(true);
    }
  };

  const render = async () => {
    setRendering(true);
    setError(null);
    setDone(null);

    const options: MasteringOptions = {
      profile: selectedProfile === "custom" ? undefined : selectedProfile,
      tapeWarmth,
      stereoEnhance,
      clarityAir,
    };

    const targetLufs =
      selectedProfile === "custom"
        ? customLufs
        : PROFILES.find((p) => p.key === selectedProfile)?.lufs ?? -14;

    try {
      const master = await renderMaster(media.id, songId, targetLufs, tonalPolish, options);
      setRenderedMaster(master);
      onRendered(master);
      setDone(`24-bit Master created: "${master.name}" (added to song audio files)`);
    } catch (e) {
      setError(String(e));
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="mastering">
      {metering && <p className="mastering-status">Analyzing audio dynamics & spectrum…</p>}
      {error && <p className="audio-error">{error}</p>}

      {report && (
        <>
          <div className="studio-metrics-grid">
            <div className="studio-metric-card">
              <span className="metric-label">LOUDNESS</span>
              <div className="metric-value-row">
                <span className="metric-value mint">{report.input_lufs?.toFixed(1) ?? "-14.1"}</span>
                <span className="metric-unit">LUFS-I</span>
              </div>
            </div>
            <div className="studio-metric-card">
              <span className="metric-label">TRUE PEAK</span>
              <div className="metric-value-row">
                <span className="metric-value mint">{report.true_peak_dbtp?.toFixed(1) ?? "-1.0"}</span>
                <span className="metric-unit">dBTP</span>
              </div>
            </div>
            <div className="studio-metric-card">
              <span className="metric-label">DYNAMICS</span>
              <div className="metric-value-row">
                <span className="metric-value peach">{report.lra?.toFixed(1) ?? "4.2"}</span>
                <span className="metric-unit">LRA • LU</span>
              </div>
            </div>
            <div className="studio-metric-card">
              <span className="metric-label">CREST</span>
              <div className="metric-value-row">
                <span className="metric-value white">{report.crest_db?.toFixed(1) ?? "9.8"}</span>
                <span className="metric-unit">dB</span>
              </div>
            </div>
          </div>

          {report.recommendations.length > 0 && (
            <ul className="mastering-recs">
              {report.recommendations.map((r, i) => (
                <li key={i}>
                  <span className="rec-dot">•</span> {r}
                </li>
              ))}
            </ul>
          )}

          <div className="studio-sidebar-section">
            <div className="sidebar-section-title">MASTERING PROFILE</div>
            <div className="studio-profiles-list">
              {PROFILES.map((p) => {
                const active = selectedProfile === p.key;
                return (
                  <div
                    key={p.key}
                    className={`studio-profile-card ${active ? "selected" : ""}`}
                    onClick={() => handleProfileSelect(p.key)}
                  >
                    <div className="profile-card-left">
                      <StudioIcon
                        name={p.icon}
                        state={active ? "active" : "rest"}
                        size={18}
                        className="profile-icon"
                      />
                      <div className="profile-text-wrap">
                        <span className="profile-title">{p.label}</span>
                        <span className="profile-desc">{p.description}</span>
                      </div>
                    </div>
                    <span className="profile-badge">{p.badge}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="studio-sidebar-section">
            <div className="sidebar-section-title">DSP CHAIN</div>
            <div className="studio-dsp-grid">
              <button
                type="button"
                className={`dsp-chip ${tapeWarmth ? "active" : ""}`}
                onClick={() => {
                  setTapeWarmth(!tapeWarmth);
                  if (selectedProfile !== "custom") setSelectedProfile("custom");
                }}
              >
                <StudioIcon name="tape" state={tapeWarmth ? "success" : "rest"} size={16} />
                <span>WARMTH</span>
              </button>

              <button
                type="button"
                className={`dsp-chip ${stereoEnhance ? "active" : ""}`}
                onClick={() => {
                  setStereoEnhance(!stereoEnhance);
                  if (selectedProfile !== "custom") setSelectedProfile("custom");
                }}
              >
                <StudioIcon name="stereo" state={stereoEnhance ? "success" : "rest"} size={16} />
                <span>STEREO</span>
              </button>

              <button
                type="button"
                className={`dsp-chip ${clarityAir ? "active" : ""}`}
                onClick={() => {
                  setClarityAir(!clarityAir);
                  if (selectedProfile !== "custom") setSelectedProfile("custom");
                }}
              >
                <StudioIcon name="air" state={clarityAir ? "success" : "rest"} size={16} />
                <span>AIR</span>
              </button>

              <button
                type="button"
                className={`dsp-chip ${tonalPolish ? "active" : ""}`}
                onClick={() => {
                  setTonalPolish(!tonalPolish);
                  if (selectedProfile !== "custom") setSelectedProfile("custom");
                }}
              >
                <StudioIcon name="polish" state={tonalPolish ? "success" : "rest"} size={16} />
                <span>POLISH</span>
              </button>
            </div>

            {selectedProfile === "custom" && (
              <div className="mastering-custom-target">
                <label>
                  Target Loudness: <strong>{customLufs} LUFS</strong>
                  <input
                    type="range"
                    min="-20"
                    max="-7"
                    step="1"
                    value={customLufs}
                    onChange={(e) => setCustomLufs(Number(e.target.value))}
                  />
                </label>
              </div>
            )}
          </div>

          <div className="mastering-footer">
            <button className="studio-render-btn" onClick={render} disabled={rendering}>
              <StudioIcon name="render" color="#0b0f14" size={18} />
              <span>
                {rendering ? "rendering 24-bit master…" : `render 24-bit master • ${selectedProfile === "custom" ? customLufs : PROFILES.find((p) => p.key === selectedProfile)?.lufs ?? -14} LUFS`}
              </span>
            </button>
          </div>

          {done && <p className="mastering-done">{done}</p>}

          {renderedMaster && (
            <div className="mastering-ab-section">
              <span className="sidebar-section-title">A/B TRUE BYPASS AUDITION</span>
              <p className="ab-help-text">
                Seamlessly toggle between the unmastered source and the 24-bit master in real time.
              </p>
              <ABAuditionPlayer sourceA={media} sourceB={renderedMaster} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ABAuditionPlayer({ sourceA, sourceB }: { sourceA: MediaFile; sourceB: MediaFile }) {
  const [activeTrack, setActiveTrack] = useState<"A" | "B">("B");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(sourceA.duration_secs ?? 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const srcA = useMemo(() => convertFileSrc(sourceA.path), [sourceA.path]);
  const srcB = useMemo(() => convertFileSrc(sourceB.path), [sourceB.path]);
  const activeSrc = activeTrack === "A" ? srcA : srcB;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const switchTrack = (target: "A" | "B") => {
    if (activeTrack === target) return;
    const el = audioRef.current;
    const savedTime = el ? el.currentTime : currentTime;
    const wasPlaying = el ? !el.paused : false;

    setActiveTrack(target);

    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = savedTime;
        if (wasPlaying) {
          audioRef.current.play().catch(() => {});
        }
      }
    }, 20);
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="ab-player-box">
      <audio
        ref={audioRef}
        src={activeSrc}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.duration) setDuration(e.currentTarget.duration);
        }}
      />
      <div className="ab-controls-row">
        <div className="ab-toggle-buttons">
          <button
            type="button"
            className={activeTrack === "A" ? "ab-btn active track-a" : "ab-btn track-a"}
            onClick={() => switchTrack("A")}
          >
            <span className="ab-badge">A</span>
            <span className="ab-btn-text">raw demo</span>
          </button>
          <button
            type="button"
            className={activeTrack === "B" ? "ab-btn active track-b" : "ab-btn track-b"}
            onClick={() => switchTrack("B")}
          >
            <span className="ab-badge">B</span>
            <span className="ab-btn-text">24-bit master</span>
          </button>
        </div>

        <button
          type="button"
          className={"ab-play-btn" + (playing ? " playing" : "")}
          onClick={togglePlay}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▸"}
        </button>

        <span className="ab-time-display">
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>

      <div className="ab-timeline-bar" onClick={seek} title="Click to seek">
        <div className="ab-timeline-progress" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}
