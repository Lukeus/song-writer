import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  analyzeMedia,
  dissociateMedia,
  importAudioFile,
  listSongMedia,
  parseChords,
  transcribeMedia,
  type MediaFile,
} from "../../api";
import { MasteringSection } from "./MasteringSection";
import { AudioPlayer } from "./AudioPlayer";
import { AudioStudioModal } from "../../components/AudioStudioModal";
import type { UtilityContext } from "../types";

const AUDIO_EXTS = ["mp3", "wav", "aiff", "aif", "m4a", "flac", "ogg"];

function formatDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function hasAudioExt(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTS.includes(ext);
}

/** Audio Analysis utility: import music files, analyze BPM/key/chords, link to song. */
export function AudioAnalysisPanel({
  activeSongId,
  activeSong,
  insertLyrics,
  insertBlocks,
  onSongChanged,
}: UtilityContext) {
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [lyricsFor, setLyricsFor] = useState<number | null>(null);
  const [isolateVocals, setIsolateVocals] = useState(false);
  const [masteringFor, setMasteringFor] = useState<number | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);

  const songOpen = activeSong != null;

  const refresh = useCallback(() => {
    if (activeSongId == null) {
      setMedia([]);
      return;
    }
    listSongMedia(activeSongId)
      .then(setMedia)
      .catch((e) => setError(String(e)));
  }, [activeSongId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Replace a single media row in state (after analysis updates). */
  const mergeMedia = (m: MediaFile) =>
    setMedia((prev) => prev.map((x) => (x.id === m.id ? m : x)));

  const importAndAnalyze = useCallback(
    async (paths: string[]) => {
      if (activeSongId == null) return;
      setError(null);
      setBusy(true);
      try {
        for (const path of paths) {
          if (!hasAudioExt(path)) continue;
          const imported = await importAudioFile(activeSongId, path);
          setMedia((prev) =>
            prev.some((x) => x.id === imported.id) ? prev : [imported, ...prev],
          );
          // Kick off analysis; update the row when it resolves.
          analyzeMedia(imported.id).then(mergeMedia).catch((e) => setError(String(e)));
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [activeSongId],
  );

  // Keep a ref so the Tauri drag-drop listener always sees the latest handler.
  const importRef = useRef(importAndAnalyze);
  importRef.current = importAndAnalyze;

  // OS-level file drops are delivered through Tauri's webview drag-drop events.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over" || p.type === "enter") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        if (songOpen) importRef.current(p.paths);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [songOpen]);

  const browse = async () => {
    const selected = await open({
      multiple: true,
      title: "Choose audio files",
      filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    importAndAnalyze(paths);
  };

  const reanalyze = async (m: MediaFile) => {
    mergeMedia({ ...m, analysis_status: "running" });
    try {
      mergeMedia(await analyzeMedia(m.id));
    } catch (e) {
      setError(String(e));
    }
  };

  const transcribe = async (m: MediaFile) => {
    setError(null);
    mergeMedia({ ...m, transcription_status: "running" });
    setLyricsFor(m.id);
    try {
      mergeMedia(await transcribeMedia(m.id, isolateVocals));
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (m: MediaFile) => {
    if (activeSongId == null) return;
    await dissociateMedia(activeSongId, m.id);
    setMedia((prev) => prev.filter((x) => x.id !== m.id));
  };

  const syncChordsToEditor = (m: MediaFile) => {
    const chords = parseChords(m);
    if (chords.length === 0 || !activeSong) return;
    const content: any[] = [];
    chords.forEach((c, idx) => {
      content.push({ type: "chord", attrs: { chord: c.label } });
      content.push({ type: "text", text: idx < chords.length - 1 ? "   " : " " });
    });
    insertBlocks([{ type: "paragraph", content }]);
  };

  const adoptKeyBpm = (_m: MediaFile) => {
    if (!activeSong) return;
    onSongChanged(activeSong);
  };

  return (
    <div className="audio-panel">
      <div className="audio-panel-header">
        <h2>AUDIO ANALYSIS</h2>
        <div className="audio-panel-header-actions">
          <button
            type="button"
            className="audio-studio-open-btn"
            onClick={() => setStudioOpen(true)}
            disabled={!songOpen || media.length === 0}
            title="Open Interactive Parametric EQ & A/B Comparison Studio"
          >
            studio & eq
          </button>
          <button onClick={browse} disabled={!songOpen || busy}>
            {busy ? "importing…" : "browse…"}
          </button>
        </div>
      </div>

      <div
        className={
          "audio-dropzone" +
          (dragging ? " dragging" : "") +
          (songOpen ? "" : " disabled")
        }
      >
        <div>
          {songOpen
            ? "drop an audio file to analyze"
            : "open a song first to attach audio"}
        </div>
        <div className="audio-dropzone-sub">
          MP3 · WAV · AIFF · M4A · FLAC
        </div>
      </div>

      <label className="audio-isolate-toggle" title="Separate the vocals with Demucs before transcribing — more accurate on full mixes, but noticeably slower.">
        <input
          type="checkbox"
          checked={isolateVocals}
          onChange={(e) => setIsolateVocals(e.target.checked)}
        />
        isolate vocals before transcribing (slower, more accurate)
      </label>

      {error && <p className="audio-error">{error}</p>}

      {songOpen && media.length === 0 && !error && (
        <p className="audio-empty">No audio attached yet.</p>
      )}

      <ul className="audio-list">
        {media.map((m) => {
          const chords = parseChords(m);
          const isOpen = expanded === m.id;
          return (
            <li key={m.id} className="audio-item">
              <div className="audio-item-main">
                <span className="audio-name" title={m.path}>
                  {m.name}
                </span>
                <span className="audio-meta">
                  <span className={`audio-status status-${m.analysis_status}`}>
                    {m.analysis_status}
                  </span>
                  {m.bpm != null && <> · {m.bpm} BPM</>}
                  {m.musical_key && <> · {m.musical_key}</>}
                  {m.duration_secs != null && <> · {formatDuration(m.duration_secs)}</>}
                </span>
                {m.analysis_status === "error" && m.analyzer_error && (
                  <span className="audio-item-error">{m.analyzer_error}</span>
                )}
              </div>
              <AudioPlayer media={m} onOpenStudio={() => setStudioOpen(true)} />
              <div className="audio-item-actions">
                {chords.length > 0 && (
                  <button
                    className="audio-btn-primary"
                    onClick={() => syncChordsToEditor(m)}
                    disabled={!songOpen}
                    title="Insert detected chord progression into the song editor"
                  >
                    sync chords
                  </button>
                )}
                <button
                  className={masteringFor === m.id ? "audio-btn-peach active" : "audio-btn-peach"}
                  onClick={() => setMasteringFor(masteringFor === m.id ? null : m.id)}
                  title="Analyze loudness and render a mastered copy"
                >
                  {masteringFor === m.id ? "hide mastering" : "master"}
                </button>
                {(m.musical_key || m.bpm != null) && (
                  <button
                    onClick={() => adoptKeyBpm(m)}
                    disabled={!songOpen}
                    title={`Use ${m.musical_key || ""} ${m.bpm ? `${m.bpm} BPM` : ""} for song suggestions`}
                  >
                    use key + bpm
                  </button>
                )}
                <button
                  onClick={() => reanalyze(m)}
                  disabled={m.analysis_status === "running"}
                  title="Re-run analysis"
                >
                  re-analyze
                </button>
                {chords.length > 0 && (
                  <button onClick={() => setExpanded(isOpen ? null : m.id)}>
                    {isOpen ? "hide chords" : `chords (${chords.length})`}
                  </button>
                )}
                {m.lyrics && (
                  <button
                    className={lyricsFor === m.id ? "active" : ""}
                    onClick={() => setLyricsFor(lyricsFor === m.id ? null : m.id)}
                  >
                    {lyricsFor === m.id ? "hide lyrics" : "lyrics"}
                  </button>
                )}
                <button
                  onClick={() => transcribe(m)}
                  disabled={m.transcription_status === "running"}
                  title="Transcribe the vocals into lyrics (local Whisper)"
                >
                  {m.transcription_status === "running"
                    ? "transcribing…"
                    : m.lyrics
                      ? "re-transcribe"
                      : "transcribe lyrics"}
                </button>
                <button onClick={() => revealItemInDir(m.path)} title="Reveal in Finder">
                  reveal
                </button>
                <button onClick={() => remove(m)} title="Remove from song">
                  remove
                </button>
              </div>
              {isOpen && chords.length > 0 && (
                <ol className="audio-chords">
                  {chords.map((c, i) => (
                    <li key={i}>
                      <span className="chord-time">{c.time.toFixed(1)}s</span>
                      <span className="chord-label">{c.label}</span>
                    </li>
                  ))}
                </ol>
              )}
              {m.transcription_status === "error" && m.transcription_error && (
                <p className="audio-item-error">{m.transcription_error}</p>
              )}
              {lyricsFor === m.id && (
                <div className="audio-lyrics">
                  {m.transcription_status === "running" && !m.lyrics ? (
                    <p className="audio-lyrics-status">Transcribing vocals…</p>
                  ) : m.lyrics ? (
                    <>
                      <div className="audio-lyrics-actions">
                        <button
                          onClick={() => insertLyrics(m.lyrics ?? "")}
                          disabled={!activeSong}
                          title="Append these lyrics into the song editor"
                        >
                          Insert into editor
                        </button>
                        {m.lyrics_language && (
                          <span className="audio-lyrics-lang">{m.lyrics_language}</span>
                        )}
                      </div>
                      <pre className="audio-lyrics-text">{m.lyrics}</pre>
                    </>
                  ) : (
                    <p className="audio-lyrics-status">No lyrics detected.</p>
                  )}
                </div>
              )}
              {masteringFor === m.id && activeSongId != null && (
                <MasteringSection
                  media={m}
                  songId={activeSongId}
                  onRendered={(master) => {
                    setMedia((prev) =>
                      prev.some((x) => x.id === master.id) ? prev : [master, ...prev],
                    );
                    analyzeMedia(master.id)
                      .then(mergeMedia)
                      .catch((e) => setError(String(e)));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {studioOpen && (
        <AudioStudioModal
          isOpen={studioOpen}
          onClose={() => setStudioOpen(false)}
          songId={activeSongId ?? undefined}
          availableMedia={media}
          onMasterRendered={(master) => {
            setMedia((prev) =>
              prev.some((x) => x.id === master.id) ? prev : [master, ...prev],
            );
            analyzeMedia(master.id)
              .then(mergeMedia)
              .catch((e) => setError(String(e)));
          }}
        />
      )}
    </div>
  );
}
