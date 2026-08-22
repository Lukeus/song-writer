import { useMemo } from "react";
import { useGlobalAudio } from "../audio/GlobalAudioContext";

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function GlobalAudioBar({ onOpenStudio }: { onOpenStudio?: () => void }) {
  const {
    primaryTrack,
    referenceTrack,
    activeSource,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isEqBypassed,
    setActiveSource,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    toggleEqBypass,
    loop,
    setLoop,
  } = useGlobalAudio();

  const progress = useMemo(() => {
    return duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  }, [currentTime, duration]);

  if (!primaryTrack && !referenceTrack) {
    return null;
  }

  const activeTrack = activeSource === "primary" ? primaryTrack : (referenceTrack ?? primaryTrack);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  return (
    <footer className="global-audio-bar" role="region" aria-label="Global Audio Player">
      {/* Track Info */}
      <div className="gab-track-info">
        <div className="gab-cover-icon">
          <span className="gab-icon-glyph">{activeSource === "reference" ? "◈" : "▸"}</span>
        </div>
        <div className="gab-details">
          <div className="gab-title" title={activeTrack?.name}>
            {activeTrack?.name || "No Track Loaded"}
          </div>
          <div className="gab-meta">
            <span className={`gab-badge ${activeSource}`}>
              {activeSource === "primary" ? "TRACK A" : "REF · TRACK B"}
            </span>
            {activeTrack?.musical_key && (
              <span className="gab-tag">{activeTrack.musical_key}</span>
            )}
            {activeTrack?.bpm && (
              <span className="gab-tag">{Math.round(activeTrack.bpm)} BPM</span>
            )}
            {isEqBypassed && <span className="gab-bypass-tag">BYPASSED</span>}
          </div>
        </div>
      </div>

      {/* Main Transport & Timeline */}
      <div className="gab-center-controls">
        <div className="gab-buttons">
          {/* A/B Switcher */}
          {referenceTrack && (
            <div className="gab-ab-toggle">
              <button
                type="button"
                className={`ab-btn ${activeSource === "primary" ? "active" : ""}`}
                onClick={() => setActiveSource("primary")}
                title="Switch to Track A (Main with EQ)"
              >
                A
              </button>
              <button
                type="button"
                className={`ab-btn ${activeSource === "reference" ? "active" : ""}`}
                onClick={() => setActiveSource("reference")}
                title="Switch to Track B (Reference)"
              >
                B
              </button>
            </div>
          )}

          {/* Skip back 5s */}
          <button
            type="button"
            className="gab-icon-btn"
            onClick={() => seek(Math.max(0, currentTime - 5))}
            title="Rewind 5s"
          >
            −5s
          </button>

          {/* Play / Pause */}
          <button
            type="button"
            className={`gab-play-btn ${isPlaying ? "playing" : ""}`}
            onClick={togglePlay}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? "❚❚" : "▸"}
          </button>

          {/* Skip forward 5s */}
          <button
            type="button"
            className="gab-icon-btn"
            onClick={() => seek(Math.min(duration, currentTime + 5))}
            title="Forward 5s"
          >
            +5s
          </button>

          {/* Loop */}
          <button
            type="button"
            className={`gab-icon-btn ${loop ? "active" : ""}`}
            onClick={() => setLoop(!loop)}
            title={loop ? "Disable Loop" : "Enable Loop"}
          >
            LOOP
          </button>
        </div>

        {/* Scrub bar */}
        <div className="gab-timeline">
          <span className="gab-time">{fmtTime(currentTime)}</span>
          <div className="gab-progress-track" onClick={handleSeek}>
            <div
              className="gab-progress-fill"
              style={{ width: `${progress * 100}%` }}
            />
            <div
              className="gab-progress-handle"
              style={{ left: `${progress * 100}%` }}
            />
          </div>
          <span className="gab-time gab-duration">{fmtTime(duration)}</span>
        </div>
      </div>

      {/* Right controls: EQ Quick Toggle, Studio Open, Volume */}
      <div className="gab-right-controls">
        <button
          type="button"
          className={`gab-eq-toggle-btn ${!isEqBypassed ? "active" : "bypassed"}`}
          onClick={toggleEqBypass}
          title={isEqBypassed ? "Enable Parametric EQ" : "Bypass Parametric EQ"}
        >
          EQ · {!isEqBypassed ? "ON" : "OFF"}
        </button>

        {onOpenStudio && (
          <button
            type="button"
            className="gab-studio-btn"
            onClick={onOpenStudio}
            title="Open Full EQ & Spectrum Visualizer Studio"
          >
            studio
          </button>
        )}

        {/* Volume Slider */}
        <div className="gab-volume-container">
          <button
            type="button"
            className="gab-icon-btn vol-btn"
            onClick={toggleMute}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? "MUTE" : "VOL"}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="gab-vol-slider"
            title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
          />
        </div>
      </div>
    </footer>
  );
}
