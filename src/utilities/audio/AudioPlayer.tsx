import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useGlobalAudio } from "../../audio/GlobalAudioContext";
import type { MediaFile } from "../../api";

/**
 * Stable pseudo-random waveform bar heights derived from the file id, so each
 * track gets a distinct-but-consistent waveform without decoding the audio.
 * Returns `count` values in the range 0.18–1.0 (fraction of full bar height).
 */
function waveformBars(seed: number, count = 48): number[] {
  const bars: number[] = [];
  let s = (seed + 1) * 9301 + 49297;
  for (let i = 0; i < count; i++) {
    s = (s * 9301 + 49297) % 233280;
    bars.push(0.18 + (s / 233280) * 0.82);
  }
  return bars;
}

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Inline play/pause + seekable waveform for one attached audio file with Global Player routing. */
export function AudioPlayer({
  media,
  onOpenStudio,
}: {
  media: MediaFile;
  onOpenStudio?: () => void;
}) {
  const {
    primaryTrack,
    activeSource,
    isPlaying: globalPlaying,
    currentTime: globalCurrentTime,
    duration: globalDuration,
    playTrack,
    togglePlay: toggleGlobalPlay,
    seek: globalSeek,
    setReferenceTrack,
    referenceTrack,
  } = useGlobalAudio();

  const isGlobalTarget = primaryTrack?.id === media.id;
  const isGlobalRef = referenceTrack?.id === media.id;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localCurrent, setLocalCurrent] = useState(0);
  const [localDuration, setLocalDuration] = useState(media.duration_secs ?? 0);
  const [error, setError] = useState(false);

  const src = useMemo(() => convertFileSrc(media.path), [media.path]);
  const bars = useMemo(() => waveformBars(media.id), [media.id]);

  // Use global timing if this track is the active global primary track
  const isPlaying = isGlobalTarget && activeSource === "primary" ? globalPlaying : localPlaying;
  const current = isGlobalTarget && activeSource === "primary" ? globalCurrentTime : localCurrent;
  const duration = isGlobalTarget && activeSource === "primary" ? (globalDuration || localDuration) : localDuration;

  // Reset transport when the underlying file changes.
  useEffect(() => {
    setLocalPlaying(false);
    setLocalCurrent(0);
    setError(false);
    setLocalDuration(media.duration_secs ?? 0);
  }, [media.path, media.duration_secs]);

  const toggle = () => {
    if (isGlobalTarget) {
      toggleGlobalPlay();
      return;
    }

    // Load into global audio engine
    playTrack(media);
  };

  const progress = duration > 0 ? current / duration : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * duration;

    if (isGlobalTarget) {
      globalSeek(target);
    } else {
      const el = audioRef.current;
      if (el) {
        el.currentTime = target;
        setLocalCurrent(target);
      }
    }
  };

  return (
    <div className={`audio-player ${isGlobalTarget ? "global-active" : ""}`}>
      {!isGlobalTarget && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onPlay={() => setLocalPlaying(true)}
          onPause={() => setLocalPlaying(false)}
          onEnded={() => {
            setLocalPlaying(false);
            setLocalCurrent(0);
          }}
          onTimeUpdate={(e) => setLocalCurrent(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) =>
            setLocalDuration(e.currentTarget.duration || media.duration_secs || 0)
          }
          onError={() => setError(true)}
        />
      )}
      <button
        className={"audio-play" + (isPlaying ? " playing" : "")}
        onClick={toggle}
        disabled={error}
        title={isPlaying ? "Pause" : "Play with EQ Engine"}
        aria-label={isPlaying ? "Pause" : "Play with EQ Engine"}
      >
        {isPlaying ? "❚❚" : "▸"}
      </button>
      <div
        className="audio-wave"
        onClick={seek}
        title={error ? "File could not be loaded" : "Click to seek"}
      >
        {bars.map((h, i) => (
          <span
            key={i}
            className={"wave-bar" + (i / bars.length < progress ? " played" : "")}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        ))}
      </div>
      <span className="audio-time">
        {error ? "unplayable" : `${fmt(current)} / ${fmt(duration)}`}
      </span>

      {/* Quick Action buttons */}
      <div className="audio-player-actions">
        {onOpenStudio && (
          <button
            type="button"
            className="player-action-btn"
            onClick={() => {
              playTrack(media);
              onOpenStudio();
            }}
            title="Open in EQ & Mastering Studio"
          >
            EQ Studio
          </button>
        )}
        <button
          type="button"
          className={`player-action-btn ${isGlobalRef ? "active" : ""}`}
          onClick={() => {
            setReferenceTrack(isGlobalRef ? null : media);
          }}
          title={isGlobalRef ? "Clear Reference Track" : "Set as A/B Reference Track"}
        >
          {isGlobalRef ? "◈ Ref B" : "Set Ref"}
        </button>
      </div>
    </div>
  );
}
