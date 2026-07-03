import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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

/** Inline play/pause + seekable waveform for one attached audio file. */
export function AudioPlayer({ media }: { media: MediaFile }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(media.duration_secs ?? 0);
  const [error, setError] = useState(false);

  const src = useMemo(() => convertFileSrc(media.path), [media.path]);
  const bars = useMemo(() => waveformBars(media.id), [media.id]);

  // Reset transport when the underlying file changes.
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setError(false);
    setDuration(media.duration_secs ?? 0);
  }, [media.path, media.duration_secs]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => setError(true));
    else el.pause();
  };

  const progress = duration > 0 ? current / duration : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrent(el.currentTime);
  };

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) =>
          setDuration(e.currentTarget.duration || media.duration_secs || 0)
        }
        onError={() => setError(true)}
      />
      <button
        className={"audio-play" + (playing ? " playing" : "")}
        onClick={toggle}
        disabled={error}
        title={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▸"}
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
    </div>
  );
}
