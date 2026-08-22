import { Channel, invoke } from "@tauri-apps/api/core";
import type { JSONContent } from "@tiptap/react";

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

/** An alternative version inside a Logic Pro project bundle. */
export interface ProjectAlternative {
  id: string;
  name: string;
  modified_at: string | null;
}

/** Deep metadata extracted from a `.logicx` project bundle. */
export interface LogicProjectDetails {
  name: string;
  path: string;
  alternatives: ProjectAlternative[];
  bounces_count: number;
  audio_files_count: number;
  created_at: string | null;
  modified_at: string | null;
}

/** Result of waveform & metadata matching between a song and a Logic project. */
export interface AudioMatchResult {
  logic_project_id: number;
  logic_project_name: string;
  logic_project_path: string;
  matched_bounce_path: string;
  matched_bounce_name: string;
  confidence_pct: number;
  similarity_score: number;
  match_reason: string;
  origin?: string | null;
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

/** A bounced audio file found inside or next to a Logic Pro project bundle, or in a global bounce directory. */
export interface ProjectBounce {
  name: string;
  path: string;
  size_bytes: number;
  format: string;
  modified_at: string | null;
  origin?: string | null;
}

/** A registered global bounce / export folder. */
export interface BounceFolder {
  id: number;
  path: string;
  created_at: string;
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

export const openLogicProject = (path: string) =>
  invoke<void>("open_logic_project", { path });

export const listProjectBounces = (projectPath: string) =>
  invoke<ProjectBounce[]>("list_project_bounces", { projectPath });

export const getLogicProjectDetails = (path: string) =>
  invoke<LogicProjectDetails>("get_logic_project_details", { path });

export const findMatchingLogicProjects = (songId: number) =>
  invoke<AudioMatchResult[]>("find_matching_logic_projects", { songId });

export const cancelWaveformSearch = () =>
  invoke<boolean>("cancel_waveform_search");

export const exportSongMidi = (songId: number, destinationPath: string, bpm?: number) =>
  invoke<string>("export_song_midi", { songId, destinationPath, bpm });

export const listGlobalBounceFolders = () =>
  invoke<BounceFolder[]>("list_global_bounce_folders");

export const addGlobalBounceFolder = (path: string) =>
  invoke<BounceFolder>("add_global_bounce_folder", { path });

export const deleteGlobalBounceFolder = (id: number) =>
  invoke<void>("delete_global_bounce_folder", { id });

// ---- Audio analysis utility ----------------------------------------------

export const importAudioFile = (songId: number, path: string) =>
  invoke<MediaFile>("import_audio_file", { songId, path });

export const listSongMedia = (songId: number) =>
  invoke<MediaFile[]>("list_song_media", { songId });

export const analyzeMedia = (mediaFileId: number) =>
  invoke<MediaFile>("analyze_media", { mediaFileId });

/**
 * Transcribe the file's vocals into lyrics (local Whisper). When
 * `isolateVocals` is set, Demucs first separates the mix and only the vocals
 * stem is transcribed — slower, but more accurate on full mixes.
 */
export const transcribeMedia = (mediaFileId: number, isolateVocals = false) =>
  invoke<MediaFile>("transcribe_media", { mediaFileId, isolateVocals });

export const dissociateMedia = (songId: number, mediaFileId: number) =>
  invoke<void>("dissociate_media", { songId, mediaFileId });

export const deleteMediaFile = (mediaFileId: number) =>
  invoke<void>("delete_media_file", { mediaFileId });

/** Measure loudness / true-peak / dynamics / tonal balance + recommendations. */
export const meterMaster = (mediaFileId: number) =>
  invoke<MasteringReport>("meter_master", { mediaFileId });

/** Optional character & DSP toggles for audio mastering. */
export interface MasteringOptions {
  profile?: "warm" | "modern" | "loud" | "dynamic" | "custom";
  tapeWarmth?: boolean;
  stereoEnhance?: boolean;
  clarityAir?: boolean;
}

/** Render a mastered copy to `targetLufs` with optional DSP enhancements. */
export const renderMaster = (
  mediaFileId: number,
  songId: number,
  targetLufs: number,
  tonalCorrection: boolean,
  options?: MasteringOptions,
) =>
  invoke<MediaFile>("render_master", {
    mediaFileId,
    songId,
    targetLufs,
    tonalCorrection,
    profile: options?.profile,
    tapeWarmth: options?.tapeWarmth,
    stereoEnhance: options?.stereoEnhance,
    clarityAir: options?.clarityAir,
  });

/** Serializable parametric EQ band for Rust FFmpeg master rendering. */
export interface EqBandParam {
  id: number;
  name: string;
  type: string;
  frequency: number;
  gain: number;
  q: number;
  enabled: boolean;
}

/** Render a mastered copy applying the exact active Parametric EQ filter curve. */
export const renderMasterWithEq = (
  mediaFileId: number,
  songId: number,
  targetLufs: number,
  eqBands: EqBandParam[],
  options?: { tapeWarmth?: boolean; stereoEnhance?: boolean },
) =>
  invoke<MediaFile>("render_master_with_eq", {
    mediaFileId,
    songId,
    targetLufs,
    eqBands,
    tapeWarmth: options?.tapeWarmth,
    stereoEnhance: options?.stereoEnhance,
  });

// ---- AI agent ------------------------------------------------------------

/** A configured model endpoint, mirrors `db::AiProvider`. */
export interface AiProvider {
  id: number;
  /** "ollama" today; more vendors get their own kind + Rust impl. */
  kind: string;
  label: string;
  base_url: string;
  /** Last model chosen for this provider, remembered across runs. */
  model: string | null;
  options_json: string | null;
  is_default: boolean;
  created_at: string;
}

/** A model the provider can serve, mirrors `ai::ModelInfo`. */
export interface AiModelInfo {
  name: string;
  parameter_size: string | null;
  /** e.g. "completion", "tools", "thinking". */
  capabilities: string[];
}

/** A chat thread, mirrors `db::AiConversation`. `song_id` is null library-wide. */
export interface AiConversation {
  id: number;
  song_id: number | null;
  provider_id: number | null;
  model: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** One turn, mirrors `db::AiMessage`. */
export interface AiMessage {
  id: number;
  conversation_id: number;
  /** "user" | "assistant". */
  role: string;
  content: string;
  /** Reasoning from thinking-capable models, kept out of `content`. */
  thinking: string | null;
  tool_calls_json: string | null;
  created_at: string;
}

/**
 * A frame of a streaming reply, mirrors `ai::StreamEvent`. `started` always
 * arrives first (carrying the id needed to cancel); exactly one of `done` /
 * `error` arrives last.
 */
export type AiStreamEvent =
  | { type: "started"; runId: number }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done"; content: string; thinking: string | null; cancelled: boolean }
  | { type: "error"; message: string };

export const aiListProviders = () => invoke<AiProvider[]>("ai_list_providers");

export const aiDefaultProvider = () => invoke<AiProvider>("ai_default_provider");

export const aiCreateProvider = (
  kind: string,
  label: string,
  baseUrl: string,
  model: string | null = null,
) => invoke<AiProvider>("ai_create_provider", { kind, label, baseUrl, model });

/** Update a provider; omitted fields keep their current value. */
export const aiUpdateProvider = (
  id: number,
  fields: { label?: string | null; baseUrl?: string | null; model?: string | null },
) =>
  invoke<AiProvider>("ai_update_provider", {
    id,
    label: fields.label ?? null,
    baseUrl: fields.baseUrl ?? null,
    model: fields.model ?? null,
  });

export const aiSetDefaultProvider = (id: number) =>
  invoke<AiProvider>("ai_set_default_provider", { id });

export const aiDeleteProvider = (id: number) => invoke<void>("ai_delete_provider", { id });

/** Probe the provider; resolves to a short status or rejects with a fixable error. */
export const aiProviderHealth = (id: number | null = null) =>
  invoke<string>("ai_provider_health", { id });

export const aiListModels = (id: number | null = null) =>
  invoke<AiModelInfo[]>("ai_list_models", { id });

/**
 * The exact context block sent to the model for a song — lyrics, chords,
 * tempo/key, linked project. Null when the song no longer exists.
 */
export const aiSongContext = (songId: number) =>
  invoke<string | null>("ai_song_context", { songId });

/**
 * Convert `[Bm]lyric` text into editor blocks, each chord becoming an inline
 * node anchored above its syllable. Bracketed text that isn't a chord symbol
 * (`[Chorus]`, `[Verse 2]`) is kept as plain text.
 */
export const aiParseLyrics = (text: string) =>
  invoke<JSONContent[]>("ai_parse_lyrics", { text });

/** A song rewrite the agent is proposing, mirrors `ai::context::ProposedEdit`. */
export interface ProposedEdit {
  /** The proposed lyrics in `[Bm]` notation. */
  lyrics: string;
  /** Those lyrics as editor blocks, ready to apply. */
  blocks: JSONContent[];
  /** The reply with the block removed — what to show as chat text. */
  prose: string;
}

/**
 * Extract a proposed song rewrite from a reply, or null if it only chatted.
 * Only the agent's fenced block is ever applied — never its commentary.
 */
export const aiProposedEdit = (text: string) =>
  invoke<ProposedEdit | null>("ai_proposed_edit", { text });

export const aiListConversations = (songId: number | null) =>
  invoke<AiConversation[]>("ai_list_conversations", { songId });

export const aiCreateConversation = (
  songId: number | null,
  model: string,
  providerId: number | null = null,
) => invoke<AiConversation>("ai_create_conversation", { songId, providerId, model });

export const aiSetConversationModel = (id: number, model: string) =>
  invoke<AiConversation>("ai_set_conversation_model", { id, model });

export const aiDeleteConversation = (id: number) =>
  invoke<void>("ai_delete_conversation", { id });

export const aiListMessages = (conversationId: number) =>
  invoke<AiMessage[]>("ai_list_messages", { conversationId });

/**
 * Send a turn and stream the reply. `onEvent` fires for each frame; the promise
 * resolves with the persisted assistant message once the run ends, or null if
 * the run was stopped before producing anything.
 *
 * `think` must be null unless the model advertises the `thinking` capability.
 */
export function aiSendMessage(
  conversationId: number,
  content: string,
  think: boolean | null,
  onEvent: (event: AiStreamEvent) => void,
): Promise<AiMessage | null> {
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = onEvent;
  return invoke<AiMessage | null>("ai_send_message", {
    conversationId,
    content,
    think,
    onEvent: channel,
  });
}

/** Stop an in-flight run. Resolves false if it had already finished. */
export const aiCancelRun = (runId: number) => invoke<boolean>("ai_cancel_run", { runId });

/** Drop a message and everything after it, so a turn can be re-asked. */
export const aiTruncateFrom = (messageId: number) =>
  invoke<void>("ai_truncate_from", { messageId });

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
