import { invoke } from "@tauri-apps/api/core";

/** A song row, mirrors `db::Song` in Rust. */
export interface Song {
  id: number;
  title: string;
  /** TipTap document JSON, stringified. */
  content_json: string;
  created_at: string;
  updated_at: string;
  logic_project_id: number | null;
}

/** A catalogued Logic Pro project, mirrors `db::LogicProjectRow`. */
export interface LogicProject {
  id: number;
  name: string;
  path: string;
  created_at: string | null;
  modified_at: string | null;
  last_scanned_at: string;
}

/** A chord detected at a point in time within a media file. */
export interface ChordHit {
  time: number;
  label: string;
}

/** A transcribed lyric line with its timestamps (seconds). */
export interface LyricSegment {
  start: number;
  end: number;
  text: string;
}

/** An audio file referenced in place, mirrors `db::MediaFile`. */
export interface MediaFile {
  id: number;
  path: string;
  name: string;
  format: string | null;
  size_bytes: number | null;
  imported_at: string;
  /** "pending" | "running" | "done" | "error" */
  analysis_status: string;
  bpm: number | null;
  musical_key: string | null;
  duration_secs: number | null;
  /** JSON-stringified `ChordHit[]`, or null until analyzed. */
  chords_json: string | null;
  analyzer_error: string | null;
  analyzed_at: string | null;
  /** "pending" | "running" | "done" | "error" — tracked separately from analysis. */
  transcription_status: string;
  /** Plain-text lyrics (newline-separated), or null until transcribed. */
  lyrics: string | null;
  /** JSON-stringified `LyricSegment[]`, or null until transcribed. */
  lyrics_json: string | null;
  lyrics_language: string | null;
  transcription_error: string | null;
  transcribed_at: string | null;
}

/** Mastering analysis of a media file, mirrors `mastering::MasteringReport`. */
export interface MasteringReport {
  input_lufs: number | null;
  true_peak_dbtp: number | null;
  lra: number | null;
  rms_db: number | null;
  peak_db: number | null;
  crest_db: number | null;
  low_band_db: number | null;
  high_band_db: number | null;
  recommendations: string[];
}

// ---- Songs ---------------------------------------------------------------

export const createSong = (title: string, contentJson: string) =>
  invoke<Song>("create_song", { title, contentJson });

export const listSongs = () => invoke<Song[]>("list_songs");

export const getSong = (id: number) => invoke<Song>("get_song", { id });

export const updateSong = (id: number, title: string, contentJson: string) =>
  invoke<Song>("update_song", { id, title, contentJson });

export const deleteSong = (id: number) => invoke<void>("delete_song", { id });

export const linkSongToProject = (songId: number, logicProjectId: number | null) =>
  invoke<Song>("link_song_to_project", { songId, logicProjectId });

// ---- Logic projects ------------------------------------------------------

export const scanLogicProjects = (directory: string) =>
  invoke<LogicProject[]>("scan_logic_projects", { directory });

export const listLogicProjects = () => invoke<LogicProject[]>("list_logic_projects");

// ---- Audio analysis utility ----------------------------------------------

export const importAudioFile = (songId: number, path: string) =>
  invoke<MediaFile>("import_audio_file", { songId, path });

export const listSongMedia = (songId: number) =>
  invoke<MediaFile[]>("list_song_media", { songId });

export const analyzeMedia = (mediaFileId: number) =>
  invoke<MediaFile>("analyze_media", { mediaFileId });

/** Transcribe the file's vocals into lyrics (local Whisper). */
export const transcribeMedia = (mediaFileId: number) =>
  invoke<MediaFile>("transcribe_media", { mediaFileId });

export const dissociateMedia = (songId: number, mediaFileId: number) =>
  invoke<void>("dissociate_media", { songId, mediaFileId });

export const deleteMediaFile = (mediaFileId: number) =>
  invoke<void>("delete_media_file", { mediaFileId });

/** Measure loudness / true-peak / dynamics / tonal balance + recommendations. */
export const meterMaster = (mediaFileId: number) =>
  invoke<MasteringReport>("meter_master", { mediaFileId });

/** Render a mastered copy to `targetLufs` and associate it with the song. */
export const renderMaster = (
  mediaFileId: number,
  songId: number,
  targetLufs: number,
  tonalCorrection: boolean,
) =>
  invoke<MediaFile>("render_master", {
    mediaFileId,
    songId,
    targetLufs,
    tonalCorrection,
  });

/** Parse a media file's stored chord timeline (empty if unanalyzed/invalid). */
export function parseChords(media: MediaFile): ChordHit[] {
  if (!media.chords_json) return [];
  try {
    return JSON.parse(media.chords_json) as ChordHit[];
  } catch {
    return [];
  }
}

/** Parse a media file's stored lyric segments (empty if untranscribed/invalid). */
export function parseLyricSegments(media: MediaFile): LyricSegment[] {
  if (!media.lyrics_json) return [];
  try {
    return JSON.parse(media.lyrics_json) as LyricSegment[];
  } catch {
    return [];
  }
}
