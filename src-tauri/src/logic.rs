//! Scans a directory for Logic Pro project bundles (`.logicx`) and extracts
//! lightweight metadata from the filesystem.
//!
//! A `.logicx` is a macOS *bundle* — i.e. a directory that Finder presents as a
//! single file. We therefore look for directory entries whose name ends in
//! `.logicx`, record them, and do **not** descend into them. Rich musical
//! metadata (tempo, key, track count) lives in binary plists inside the bundle
//! and is intentionally out of scope for this first pass.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use walkdir::WalkDir;

/// Cancellation state for in-flight waveform searches across Logic projects.
#[derive(Default, Clone)]
pub struct WaveformSearchState(pub Arc<AtomicBool>);

impl WaveformSearchState {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn reset(&self) {
        self.0.store(false, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Metadata for a single Logic Pro project, as surfaced to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicProject {
    /// Project name, derived from the bundle's file name (without `.logicx`).
    pub name: String,
    /// Absolute path to the `.logicx` bundle.
    pub path: String,
    /// Filesystem creation date, RFC 3339, if the OS provides it.
    pub created_at: Option<String>,
    /// Filesystem last-modified date, RFC 3339.
    pub modified_at: Option<String>,
}

/// A bounced audio file discovered in a Logic project bundle or folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectBounce {
    /// File name (e.g. `Song A_Mix1.wav`).
    pub name: String,
    /// Absolute path to the audio file.
    pub path: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Audio format/extension (e.g. `wav`, `m4a`, `mp3`).
    pub format: String,
    /// Filesystem last-modified date, RFC 3339.
    pub modified_at: Option<String>,
    /// Origin of the bounce file (`bundle`, `global`, etc.)
    pub origin: Option<String>,
}

/// A project alternative stored inside a `.logicx` bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectAlternative {
    /// Alternative ID directory name (e.g. `000`, `001`).
    pub id: String,
    /// Display name or label.
    pub name: String,
    /// Filesystem last-modified date, RFC 3339.
    pub modified_at: Option<String>,
}

/// Deep metadata extracted from a Logic Pro project bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicProjectDetails {
    pub name: String,
    pub path: String,
    pub alternatives: Vec<ProjectAlternative>,
    pub bounces_count: usize,
    pub audio_files_count: usize,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
}

/// Result of matching a song's audio against discovered Logic Pro projects and bounces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioMatchResult {
    /// ID of the matching Logic project in the database.
    pub logic_project_id: i64,
    /// Name of the matching Logic project.
    pub logic_project_name: String,
    /// Path to the matching `.logicx` bundle.
    pub logic_project_path: String,
    /// Path to the specific bounce/audio file that matched.
    pub matched_bounce_path: String,
    /// File name of the matched bounce.
    pub matched_bounce_name: String,
    /// Confidence percentage (0.0 to 100.0).
    pub confidence_pct: f64,
    /// Raw similarity score (0.0 to 1.0).
    pub similarity_score: f64,
    /// Human-readable explanation of why this match was identified.
    pub match_reason: String,
    /// Origin of the matched bounce (`bundle` or `global`).
    pub origin: Option<String>,
}

fn system_time_to_rfc3339(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339()
}

/// Walk `root` recursively and return every `.logicx` bundle found.
///
/// Symlinks are not followed, and we never descend into a project bundle.
pub fn scan_logic_projects(root: &Path) -> Result<Vec<LogicProject>, String> {
    if !root.exists() {
        return Err(format!("Path does not exist: {}", root.display()));
    }

    let mut projects = Vec::new();

    // Drive the iterator manually so that when we hit a `.logicx` bundle we can
    // record it and then call `skip_current_dir()` — yielding the bundle but
    // never traversing the (potentially thousands of) files inside it.
    let mut it = WalkDir::new(root).follow_links(false).into_iter();
    while let Some(next) = it.next() {
        let entry = match next {
            Ok(e) => e,
            Err(_) => continue, // permission denied, broken symlink, etc.
        };

        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".logicx") {
            continue;
        }

        // Don't walk into the bundle's internals.
        if entry.file_type().is_dir() {
            it.skip_current_dir();
        }

        let Ok(meta) = entry.metadata() else { continue };

        projects.push(LogicProject {
            name: name.trim_end_matches(".logicx").to_string(),
            path: entry.path().to_string_lossy().to_string(),
            created_at: meta.created().ok().map(system_time_to_rfc3339),
            modified_at: meta.modified().ok().map(system_time_to_rfc3339),
        });
    }

    // Most-recently-modified first — the usual "what was I just working on" order.
    projects.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(projects)
}

const AUDIO_EXTENSIONS: &[&str] = &["wav", "aif", "aiff", "m4a", "mp3", "flac", "aac", "caf"];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Auto-discover standard macOS / system Logic Pro global bounce and export directories.
pub fn discover_default_global_bounce_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from);

    if let Some(home) = home {
        let candidates = [
            home.join("Music/Logic/Bounces"),
            home.join("Music/Bounces"),
            home.join("Documents/Bounces"),
            home.join("Music/Logic/Exports"),
            home.join("Music/Exports"),
            home.join("Desktop/Bounces"),
        ];
        for p in candidates {
            if p.exists() && p.is_dir() {
                dirs.push(p);
            }
        }
    }
    dirs
}

/// Discovers audio bounce files associated with a `.logicx` project across its bundle and registered global bounce directories.
pub fn scan_project_bounces_with_globals(
    project_path: &Path,
    global_dirs: &[PathBuf],
) -> Result<Vec<ProjectBounce>, String> {
    if !project_path.exists() {
        return Err(format!("Logic project path does not exist: {}", project_path.display()));
    }

    let mut bundle_search_dirs: Vec<PathBuf> = Vec::new();

    // Inside the bundle
    bundle_search_dirs.push(project_path.join("Bounces"));
    bundle_search_dirs.push(project_path.join("Audio Files"));

    // Alongside the bundle in the project directory
    if let Some(parent) = project_path.parent() {
        bundle_search_dirs.push(parent.join("Bounces"));
        bundle_search_dirs.push(parent.join("Audio Files"));
        bundle_search_dirs.push(parent.to_path_buf());
    }

    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut bounces: Vec<ProjectBounce> = Vec::new();

    // 1. Scan local bundle directories
    for dir in bundle_search_dirs {
        if !dir.exists() || !dir.is_dir() {
            continue;
        }

        // If scanning parent directory directly, only inspect top-level files (max_depth 1)
        // so we don't accidentally descend into neighboring project folders.
        let is_parent_root = project_path.parent().map(|p| p == dir).unwrap_or(false);
        let max_depth = if is_parent_root { 1 } else { 2 };

        for entry in WalkDir::new(&dir).max_depth(max_depth).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() || !is_audio_file(path) {
                continue;
            }

            let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            if !seen_paths.insert(canonical) {
                continue;
            }

            let Ok(meta) = path.metadata() else { continue };
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unnamed")
                .to_string();
            let format = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            bounces.push(ProjectBounce {
                name,
                path: path.to_string_lossy().to_string(),
                size_bytes: meta.len(),
                format,
                modified_at: meta.modified().ok().map(system_time_to_rfc3339),
                origin: Some("bundle".to_string()),
            });
        }
    }

    // 2. Scan global bounce directories for files matching this project's name
    let project_name = project_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.trim_end_matches(".logicx"))
        .unwrap_or("");

    let proj_clean = normalize_for_match(project_name);
    let proj_tokens = extract_clean_tokens(project_name);

    if !proj_clean.is_empty() {
        for g_dir in global_dirs {
            if !g_dir.exists() || !g_dir.is_dir() {
                continue;
            }

            for entry in WalkDir::new(g_dir).max_depth(2).into_iter().filter_map(|e| e.ok()) {
                let path = entry.path();
                if !path.is_file() || !is_audio_file(path) {
                    continue;
                }

                let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
                if seen_paths.contains(&canonical) {
                    continue;
                }

                let Ok(meta) = path.metadata() else { continue };
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unnamed")
                    .to_string();

                let bounce_clean = normalize_for_match(&name);
                let bounce_tokens = extract_clean_tokens(&name);

                let is_name_match = (bounce_clean.contains(&proj_clean) || proj_clean.contains(&bounce_clean))
                    || (!proj_tokens.is_empty() && proj_tokens.iter().any(|pt| bounce_tokens.contains(pt)));

                if is_name_match {
                    seen_paths.insert(canonical);
                    let format = path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();

                    bounces.push(ProjectBounce {
                        name,
                        path: path.to_string_lossy().to_string(),
                        size_bytes: meta.len(),
                        format,
                        modified_at: meta.modified().ok().map(system_time_to_rfc3339),
                        origin: Some("global".to_string()),
                    });
                }
            }
        }
    }

    // Sort by modified date descending (newest bounces first)
    bounces.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(bounces)
}

/// Discovers audio bounce files associated with a `.logicx` project.
pub fn scan_project_bounces(project_path: &Path) -> Result<Vec<ProjectBounce>, String> {
    let global_dirs = discover_default_global_bounce_dirs();
    scan_project_bounces_with_globals(project_path, &global_dirs)
}

/// Extract deep metadata from a `.logicx` project bundle, including alternatives and audio assets.
pub fn get_project_details(project_path: &Path) -> Result<LogicProjectDetails, String> {
    if !project_path.exists() {
        return Err(format!("Logic project path does not exist: {}", project_path.display()));
    }

    let meta = project_path.metadata().map_err(|e| format!("Cannot read metadata: {e}"))?;
    let name = project_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.trim_end_matches(".logicx").to_string())
        .unwrap_or_else(|| "unnamed".to_string());

    let mut alternatives: Vec<ProjectAlternative> = Vec::new();
    let alt_dir = project_path.join("Alternatives");
    if alt_dir.exists() && alt_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&alt_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let id = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    if !id.is_empty() && !id.starts_with('.') {
                        let alt_meta = p.metadata().ok();
                        let display_name = if id == "000" {
                            "Alternative 1 (Default)".to_string()
                        } else if let Ok(num) = id.parse::<u32>() {
                            format!("Alternative {}", num + 1)
                        } else {
                            format!("Alternative {id}")
                        };

                        alternatives.push(ProjectAlternative {
                            id,
                            name: display_name,
                            modified_at: alt_meta.and_then(|m| m.modified().ok()).map(system_time_to_rfc3339),
                        });
                    }
                }
            }
        }
    }
    // Sort alternatives by ID
    alternatives.sort_by(|a, b| a.id.cmp(&b.id));

    // Count audio files
    let mut audio_files_count = 0;
    let mut audio_dirs = vec![project_path.join("Audio Files")];
    if let Some(parent) = project_path.parent() {
        audio_dirs.push(parent.join("Audio Files"));
    }
    for ad in audio_dirs {
        if ad.exists() && ad.is_dir() {
            if let Ok(entries) = std::fs::read_dir(ad) {
                for e in entries.flatten() {
                    if is_audio_file(&e.path()) {
                        audio_files_count += 1;
                    }
                }
            }
        }
    }

    let bounces = scan_project_bounces(project_path).unwrap_or_default();

    Ok(LogicProjectDetails {
        name,
        path: project_path.to_string_lossy().to_string(),
        alternatives,
        bounces_count: bounces.len(),
        audio_files_count,
        created_at: meta.created().ok().map(system_time_to_rfc3339),
        modified_at: meta.modified().ok().map(system_time_to_rfc3339),
    })
}

/// Rotate a 12-bit chroma bitmask by `semitones` (0..11) for pitch transposition detection.
pub fn rotate_chroma_12(val: u32, semitones: u32) -> u32 {
    let shift = semitones % 12;
    if shift == 0 {
        return val & 0xFFF;
    }
    let v = val & 0xFFF;
    ((v << shift) | (v >> (12 - shift))) & 0xFFF
}

/// Extended fingerprint comparison with full-length sliding window and cyclic chroma transposition (Capo detection).
/// Returns `(similarity_score: 0.0..1.0, semitone_shift: -5..=6)`.
pub fn compare_fingerprints_ext(a: &[u32], b: &[u32]) -> (f64, i32) {
    if a.is_empty() || b.is_empty() {
        return (0.0, 0);
    }

    let (shorter, longer, a_is_shorter) = if a.len() <= b.len() {
        (a, b, true)
    } else {
        (b, a, false)
    };

    let s_len = shorter.len();
    let l_len = longer.len();

    // Minimum number of frames required to declare a reliable match (e.g. at least 5 frames or 60% of shorter)
    let min_overlap = if s_len <= 8 {
        s_len.max(1)
    } else {
        (s_len * 6 / 10).max(4)
    };

    let mut best_score = 0.0f64;
    let mut best_transposition = 0i32;

    // Test transpositions: original pitch (0) first, then common capo shifts (+1, -1, +2, -2, etc.)
    let transpositions: [i32; 12] = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6];

    for &trans in &transpositions {
        let rot = if trans >= 0 {
            trans as u32
        } else {
            (12 + trans) as u32
        };

        // Slide shorter across the entirety of longer
        // If lengths are close, allow slight leading/trailing overlap
        let max_offset = l_len.saturating_sub(s_len);
        let start_offset = if max_offset == 0 {
            // Near-equal lengths: allow ±15 frames overlap alignment
            let margin = 15.min(s_len / 3) as isize;
            -margin
        } else {
            0isize
        };
        let end_offset = if max_offset == 0 {
            15.min(s_len / 3) as isize
        } else {
            max_offset as isize
        };

        for offset in start_offset..=end_offset {
            let mut score_sum = 0.0f64;
            let mut overlap_count = 0usize;

            for (i, &s_val) in shorter.iter().enumerate() {
                let j = (i as isize) + offset;
                if j >= 0 && (j as usize) < l_len {
                    let l_val = longer[j as usize] & 0xFFF;
                    let rotated_s = if rot == 0 { s_val & 0xFFF } else { rotate_chroma_12(s_val, rot) };

                    let frame_score = match (rotated_s, l_val) {
                        (0, 0) => 1.0,
                        (0, _) | (_, 0) => 0.0,
                        (s, l) => {
                            let intersection = (s & l).count_ones() as f64;
                            let union = (s | l).count_ones() as f64;
                            if union > 0.0 {
                                intersection / union
                            } else {
                                1.0
                            }
                        }
                    };

                    score_sum += frame_score;
                    overlap_count += 1;
                }
            }

            if overlap_count >= min_overlap {
                let score = score_sum / (overlap_count as f64);
                // Require slightly higher threshold for transposed matches to prevent false positives
                let penalty = if trans != 0 { 0.04 } else { 0.0 };
                let effective_score = score - penalty;

                if effective_score > best_score {
                    best_score = score;
                    // Invert direction if `a` was the longer sequence
                    best_transposition = if a_is_shorter { trans } else { -trans };
                }
            }
        }
    }

    (best_score, best_transposition)
}

/// Compare two 12-bit chroma waveform fingerprints with sliding window time alignment.
/// Returns similarity score from 0.0 to 1.0.
#[allow(dead_code)]
pub fn compare_fingerprints(a: &[u32], b: &[u32]) -> f64 {
    compare_fingerprints_ext(a, b).0
}

fn extract_clean_tokens(s: &str) -> Vec<String> {
    const DAW_NOISE: &[&str] = &[
        "mix", "master", "mastered", "rough", "demo", "final", "bounced", "bounce",
        "audio", "export", "v1", "v2", "v3", "v4", "v5", "v6", "take", "take01",
        "take02", "take03", "take1", "take2", "take3", "24bit", "16bit", "44k",
        "48k", "96k", "wav", "mp3", "aif", "aiff", "m4a", "stems", "inst", "instrumental",
        "vox", "vocal", "vocals", "track", "live", "edit",
    ];

    s.split(|c: char| !c.is_alphanumeric())
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty() && !DAW_NOISE.contains(&t.as_str()) && t.len() >= 2)
        .collect()
}

fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn calculate_name_match(song_title: &str, ref_name: &str, project_name: &str, bounce_name: &str) -> (f64, Option<String>) {
    let norm_song = normalize_for_match(song_title);
    let norm_ref = normalize_for_match(ref_name);
    let norm_proj = normalize_for_match(project_name);
    let norm_bounce = normalize_for_match(bounce_name);

    if norm_song.is_empty() && norm_ref.is_empty() {
        return (0.0, None);
    }

    // 1. Exact canonical matches
    if (!norm_song.is_empty() && norm_song == norm_proj) || (!norm_song.is_empty() && norm_song == norm_bounce) {
        return (1.0, Some("Exact Title Match".to_string()));
    }
    if !norm_ref.is_empty() && norm_ref == norm_bounce {
        return (1.0, Some("Exact File Name Match".to_string()));
    }

    // 2. Tokenized DAW-cleaned word match
    let song_tokens = extract_clean_tokens(song_title);
    let ref_tokens = extract_clean_tokens(ref_name);
    let proj_tokens = extract_clean_tokens(project_name);
    let bounce_tokens = extract_clean_tokens(bounce_name);

    let mut query_tokens = song_tokens;
    for t in ref_tokens {
        if !query_tokens.contains(&t) {
            query_tokens.push(t);
        }
    }

    let mut target_tokens = proj_tokens;
    for t in bounce_tokens {
        if !target_tokens.contains(&t) {
            target_tokens.push(t);
        }
    }

    if !query_tokens.is_empty() && !target_tokens.is_empty() {
        let matching_tokens: usize = query_tokens
            .iter()
            .filter(|&qt| target_tokens.iter().any(|tt| tt == qt || tt.contains(qt) || qt.contains(tt)))
            .count();

        let ratio = (matching_tokens as f64) / (query_tokens.len().max(target_tokens.len()) as f64);
        if ratio >= 0.6 {
            return (0.9, Some("High Title/DAW Keyword Match".to_string()));
        } else if ratio >= 0.35 || matching_tokens >= 1 {
            return (0.7, Some("Title / File Keyword Match".to_string()));
        }
    }

    // 3. Substring containment fallback
    if (!norm_song.is_empty() && norm_song.len() >= 3 && (norm_proj.contains(&norm_song) || norm_bounce.contains(&norm_song)))
        || (!norm_ref.is_empty() && norm_ref.len() >= 3 && (norm_proj.contains(&norm_ref) || norm_bounce.contains(&norm_ref)))
        || (!norm_proj.is_empty() && norm_proj.len() >= 3 && (norm_song.contains(&norm_proj) || norm_ref.contains(&norm_proj)))
    {
        return (0.75, Some("Title / File Keyword Match".to_string()));
    }

    (0.0, None)
}

#[derive(Debug, Deserialize)]
struct TimedChord {
    label: String,
}

/// Extract clean, sequential chord labels from a chord timeline JSON array.
pub fn extract_chord_sequence(chords_json: &str) -> Vec<String> {
    if chords_json.trim().is_empty() {
        return Vec::new();
    }
    let parsed: Vec<TimedChord> = match serde_json::from_str(chords_json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut sequence: Vec<String> = Vec::new();
    for c in parsed {
        let sym = c.label.trim();
        if sym.is_empty() || sym == "N" || sym == "None" {
            continue;
        }
        if sequence.last().map(|last| last != sym).unwrap_or(true) {
            sequence.push(sym.to_string());
        }
    }
    sequence
}

/// Compare two chord progression sequences using normalized Longest Common Subsequence (LCS).
/// Returns similarity score from 0.0 to 1.0.
pub fn compare_chord_progressions(ref_json: &str, bounce_json: &str) -> f64 {
    let a = extract_chord_sequence(ref_json);
    let b = extract_chord_sequence(bounce_json);

    if a.is_empty() || b.is_empty() {
        return 0.0;
    }

    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];

    for i in 1..=n {
        for j in 1..=m {
            if a[i - 1].eq_ignore_ascii_case(&b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = dp[i - 1][j].max(dp[i][j - 1]);
            }
        }
    }

    let lcs = dp[n][m];
    (2.0 * lcs as f64) / ((n + m) as f64)
}

/// Find Logic Pro projects whose bounces or recordings match the song's audio waveform or metadata.
pub async fn find_matching_logic_projects(
    app: &tauri::AppHandle,
    db: &tauri::State<'_, crate::db::Db>,
    search_state: &WaveformSearchState,
    song_id: i64,
) -> Result<Vec<AudioMatchResult>, String> {
    search_state.reset();

    let (song, ref_media, all_projects, all_media_files, global_dirs) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let song = crate::db::get_song(&conn, song_id)?;
        let song_media = crate::db::list_song_media(&conn, song_id)?;
        if song_media.is_empty() {
            return Err("No audio recordings attached to this song. Attach audio first to search.".to_string());
        }

        // Select primary reference recording (prefer analyzed ones)
        let ref_media = song_media
            .iter()
            .find(|m| m.analysis_status == "done" && m.duration_secs.is_some())
            .cloned()
            .unwrap_or_else(|| song_media[0].clone());

        let all_projects = crate::db::list_logic_projects(&conn)?;
        let all_media_files = crate::db::list_all_media_files(&conn).unwrap_or_default();
        let mut g_dirs = discover_default_global_bounce_dirs();
        if let Ok(custom_dirs) = crate::db::list_global_bounce_folders(&conn) {
            for d in custom_dirs {
                let p = Path::new(&d.path).to_path_buf();
                if !g_dirs.contains(&p) && p.exists() {
                    g_dirs.push(p);
                }
            }
        }

        (song, ref_media, all_projects, all_media_files, g_dirs)
    };

    let ref_fingerprint: Vec<u32> = ref_media
        .fingerprint_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<u32>>(j).ok())
        .unwrap_or_default();

    let ref_dur = ref_media.duration_secs;
    let ref_bpm = ref_media.bpm;
    let ref_key = ref_media.musical_key.clone();

    let mut matches: Vec<AudioMatchResult> = Vec::new();

    for project in all_projects {
        if search_state.is_cancelled() {
            break;
        }

        let bounces = scan_project_bounces_with_globals(Path::new(&project.path), &global_dirs).unwrap_or_default();
        let mut best_project_match: Option<AudioMatchResult> = None;

        for bounce in bounces {
            if search_state.is_cancelled() {
                break;
            }

            let mut reasons: Vec<String> = Vec::new();
            let mut confidence = 0.0f64;
            let mut sim_score = 0.0f64;

            // 1. Name & Keyword correlation
            let (name_score, name_reason) = calculate_name_match(&song.title, &ref_media.name, &project.name, &bounce.name);
            if name_score > 0.0 {
                confidence += name_score * 50.0;
                if let Some(r) = name_reason {
                    reasons.push(r);
                }
            }

            // 2. Fetch or compute real audio analysis & waveform fingerprint for this bounce
            let cached_media = if let Some(cm) = all_media_files.iter().find(|m| m.path == bounce.path && m.fingerprint_json.is_some()) {
                Some(cm.clone())
            } else {
                // Check cancellation before launching sidecar
                if search_state.is_cancelled() {
                    break;
                }

                // Analyze on-the-fly via sidecar if not yet in cache
                if let Ok(out) = crate::utilities::audio::run_analyzer(app, &bounce.path).await {
                    let chords_json = out
                        .chords
                        .map(|c| serde_json::to_string(&c).unwrap_or_else(|_| "[]".into()));
                    let fingerprint_json = out
                        .fingerprint
                        .map(|f| serde_json::to_string(&f).unwrap_or_else(|_| "[]".into()));
                    let result = crate::db::AnalysisResult {
                        bpm: out.bpm,
                        key: out.key,
                        duration_secs: out.duration_secs,
                        chords_json,
                        fingerprint_json,
                    };

                    if let Ok(conn) = db.0.lock() {
                        if let Ok(imported) = crate::db::import_media_file(&conn, &bounce.path, &bounce.name, Some(&bounce.format), Some(bounce.size_bytes as i64)) {
                            let _ = crate::db::save_analysis(&conn, imported.id, &result);
                        }
                    }

                    Some(crate::db::MediaFile {
                        id: 0,
                        path: bounce.path.clone(),
                        name: bounce.name.clone(),
                        format: Some(bounce.format.clone()),
                        size_bytes: Some(bounce.size_bytes as i64),
                        imported_at: String::new(),
                        analysis_status: "done".into(),
                        bpm: result.bpm,
                        musical_key: result.key,
                        duration_secs: result.duration_secs,
                        chords_json: result.chords_json,
                        analyzer_error: None,
                        analyzed_at: None,
                        transcription_status: "pending".into(),
                        lyrics: None,
                        lyrics_json: None,
                        lyrics_language: None,
                        transcription_error: None,
                        transcribed_at: None,
                        fingerprint_json: result.fingerprint_json,
                    })
                } else {
                    None
                }
            };

            if let Some(cm) = cached_media {
                // Waveform fingerprint cross-correlation with Capo & Transposition detection
                let bounce_fp: Vec<u32> = cm
                    .fingerprint_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str::<Vec<u32>>(j).ok())
                    .unwrap_or_default();

                if !ref_fingerprint.is_empty() && !bounce_fp.is_empty() {
                    let (score, semitone_shift) = compare_fingerprints_ext(&ref_fingerprint, &bounce_fp);
                    sim_score = score;
                    let fp_pct = (sim_score * 100.0).round();
                    if sim_score >= 0.70 {
                        confidence += sim_score * 75.0;
                        if semitone_shift != 0 {
                            let sign = if semitone_shift > 0 { format!("+{semitone_shift}") } else { format!("{semitone_shift}") };
                            reasons.push(format!("{fp_pct:.0}% Waveform Match (Capo {sign})"));
                        } else {
                            reasons.push(format!("{fp_pct:.0}% Waveform Match"));
                        }
                    }
                }

                // Harmonic chord progression sequence matching
                if let (Some(ref_chords), Some(bounce_chords)) = (ref_media.chords_json.as_deref(), cm.chords_json.as_deref()) {
                    let chord_sim = compare_chord_progressions(ref_chords, bounce_chords);
                    if chord_sim >= 0.70 {
                        confidence += chord_sim * 25.0;
                        reasons.push(format!("Chord progression match ({:.0}%)", chord_sim * 100.0));
                    }
                }

                // Duration match check
                if let (Some(rd), Some(bd)) = (ref_dur, cm.duration_secs) {
                    let diff = (rd - bd).abs();
                    if diff <= 1.5 {
                        confidence += 25.0;
                        reasons.push(format!("Exact duration ({bd:.1}s)"));
                    } else if diff <= 5.0 {
                        confidence += 10.0;
                        reasons.push(format!("Similar duration (Δ{diff:.1}s)"));
                    }
                }

                // BPM / Key match check
                if let (Some(rb), Some(bb)) = (ref_bpm, cm.bpm) {
                    if (rb - bb).abs() <= 1.0 {
                        confidence += 5.0;
                        reasons.push(format!("BPM match ({bb:.1})"));
                    }
                }
                if let (Some(rk), Some(bk)) = (ref_key.as_deref(), cm.musical_key.as_deref()) {
                    if rk.eq_ignore_ascii_case(bk) {
                        confidence += 5.0;
                        reasons.push(format!("Key match ({bk})"));
                    }
                }
            }

            confidence = confidence.clamp(0.0, 100.0);

            // Only consider genuine matches with >= 45% confidence
            if confidence >= 45.0 {
                let reason_text = if reasons.is_empty() {
                    "Matched audio candidate".to_string()
                } else {
                    reasons.join(" · ")
                };

                let match_res = AudioMatchResult {
                    logic_project_id: project.id,
                    logic_project_name: project.name.clone(),
                    logic_project_path: project.path.clone(),
                    matched_bounce_path: bounce.path,
                    matched_bounce_name: bounce.name,
                    confidence_pct: (confidence * 10.0).round() / 10.0,
                    similarity_score: sim_score,
                    match_reason: reason_text,
                    origin: bounce.origin,
                };

                if best_project_match.as_ref().map(|b| b.confidence_pct < match_res.confidence_pct).unwrap_or(true) {
                    best_project_match = Some(match_res);
                }
            }
        }

        if let Some(m) = best_project_match {
            matches.push(m);
        }
    }

    // Sort by confidence percentage descending
    matches.sort_by(|a, b| b.confidence_pct.partial_cmp(&a.confidence_pct).unwrap_or(std::cmp::Ordering::Equal));

    Ok(matches)
}

/// Open a Logic Pro project bundle on macOS.
pub fn open_logic_project(project_path: &Path) -> Result<(), String> {
    if !project_path.exists() {
        return Err(format!("Logic project path does not exist: {}", project_path.display()));
    }

    // Try opening specifically with Logic Pro first
    let status = std::process::Command::new("open")
        .arg("-a")
        .arg("Logic Pro")
        .arg(project_path)
        .status();

    match status {
        Ok(s) if s.success() => Ok(()),
        _ => {
            // Fallback to default handler for .logicx
            let fallback_status = std::process::Command::new("open")
                .arg(project_path)
                .status()
                .map_err(|e| format!("Failed to execute open command: {e}"))?;

            if fallback_status.success() {
                Ok(())
            } else {
                Err(format!("Could not open project at: {}", project_path.display()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_bundles_without_descending_into_them() {
        // Lay out a temp tree:
        //   root/
        //     Song A.logicx/            <- bundle (a directory)
        //       Alternatives/Inner.logicx/   <- decoy nested inside a bundle
        //     nested/Song B.logicx/     <- bundle in a subdirectory
        //     notes.txt                 <- ignored
        let root = std::env::temp_dir().join(format!("sw_logic_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Song A.logicx/Alternatives/Inner.logicx")).unwrap();
        fs::create_dir_all(root.join("nested/Song B.logicx")).unwrap();
        fs::write(root.join("notes.txt"), "hi").unwrap();

        let found = scan_logic_projects(&root).unwrap();
        let names: Vec<_> = found.iter().map(|p| p.name.as_str()).collect();

        // Both top-level bundles are found...
        assert!(names.contains(&"Song A"), "got {names:?}");
        assert!(names.contains(&"Song B"), "got {names:?}");
        // ...but the bundle nested *inside* Song A must NOT be returned.
        assert!(!names.contains(&"Inner"), "should not descend into a bundle: {names:?}");
        assert_eq!(found.len(), 2, "exactly two bundles expected: {names:?}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_project_bounces_and_audio_files() {
        let root = std::env::temp_dir().join(format!("sw_bounces_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bundle = root.join("My Project.logicx");
        fs::create_dir_all(bundle.join("Bounces")).unwrap();
        fs::create_dir_all(root.join("Bounces")).unwrap();
        fs::create_dir_all(root.join("Audio Files")).unwrap();

        // Write fake audio files
        fs::write(bundle.join("Bounces/Mix_v1.wav"), "fake-wav").unwrap();
        fs::write(root.join("Bounces/Mix_v2.m4a"), "fake-m4a").unwrap();
        fs::write(root.join("Audio Files/Recording.aif"), "fake-aif").unwrap();
        fs::write(root.join("Bounces/notes.txt"), "not audio").unwrap();

        let bounces = scan_project_bounces(&bundle).unwrap();
        let names: Vec<_> = bounces.iter().map(|b| b.name.as_str()).collect();

        assert!(names.contains(&"Mix_v1.wav"), "expected Mix_v1.wav: {names:?}");
        assert!(names.contains(&"Mix_v2.m4a"), "expected Mix_v2.m4a: {names:?}");
        assert!(names.contains(&"Recording.aif"), "expected Recording.aif: {names:?}");
        assert!(!names.contains(&"notes.txt"), "notes.txt should be excluded");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_project_alternatives_and_details() {
        let root = std::env::temp_dir().join(format!("sw_details_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bundle = root.join("Summer Breeze.logicx");
        fs::create_dir_all(bundle.join("Alternatives/000")).unwrap();
        fs::create_dir_all(bundle.join("Alternatives/001")).unwrap();
        fs::create_dir_all(bundle.join("Audio Files")).unwrap();
        fs::write(bundle.join("Audio Files/take1.wav"), "fake").unwrap();

        let details = get_project_details(&bundle).unwrap();
        assert_eq!(details.name, "Summer Breeze");
        assert_eq!(details.alternatives.len(), 2);
        assert_eq!(details.alternatives[0].id, "000");
        assert_eq!(details.alternatives[0].name, "Alternative 1 (Default)");
        assert_eq!(details.alternatives[1].id, "001");
        assert_eq!(details.alternatives[1].name, "Alternative 2");
        assert_eq!(details.audio_files_count, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn compares_chroma_fingerprints() {
        // Identical fingerprints -> 1.0 similarity
        let fp1 = vec![0b101010101010, 0b110011001100, 0b111100001111];
        let fp2 = fp1.clone();
        let sim_exact = compare_fingerprints(&fp1, &fp2);
        assert!((sim_exact - 1.0).abs() < 1e-6, "exact match should be 1.0: {sim_exact}");

        // Shifted fingerprints (with 1-frame offset) -> should align via sliding window
        let mut fp_shifted = vec![0b000000000000];
        fp_shifted.extend_from_slice(&fp1);
        let sim_shifted = compare_fingerprints(&fp1, &fp_shifted);
        assert!(sim_shifted > 0.95, "shifted match should be > 0.95: {sim_shifted}");

        // Asymmetric disjoint chroma fingerprints -> low similarity
        let fp_c_major = vec![0b000010010001, 0b000010010001, 0b000010010001]; // C-E-G
        let fp_unrelated = vec![0b000000000000, 0b000000000000, 0b000000000000]; // silence/noise
        let sim_unrelated = compare_fingerprints(&fp_c_major, &fp_unrelated);
        assert!(sim_unrelated < 0.2, "unrelated match should be < 0.2: {sim_unrelated}");
    }

    #[test]
    fn tests_cyclic_chroma_transposition() {
        // Bit 0 = C (0b000000000001). Rotating left by 2 semitones gives D (bit 2 = 0b000000000100)
        let c_note = 0b000000000001;
        let d_note = rotate_chroma_12(c_note, 2);
        assert_eq!(d_note, 0b000000000100);

        // Rotating by 12 returns to original
        assert_eq!(rotate_chroma_12(c_note, 12), c_note);

        // Compare transposed sequences (e.g. Capo +2)
        let base_seq = vec![0b000000000001, 0b000000000100, 0b000000010000, 0b000001000000];
        let capo2_seq: Vec<u32> = base_seq.iter().map(|&v| rotate_chroma_12(v, 2)).collect();

        let (sim_score, semitone_shift) = compare_fingerprints_ext(&base_seq, &capo2_seq);
        assert!((sim_score - 1.0).abs() < 1e-6, "transposed sequence should match perfectly: {sim_score}");
        assert_eq!(semitone_shift, 2, "detected transposition should be +2");
    }

    #[test]
    fn tests_chord_progression_matching() {
        let ref_json = r#"[
            {"time": 0.0, "label": "Am"},
            {"time": 2.0, "label": "Am"},
            {"time": 4.0, "label": "F"},
            {"time": 8.0, "label": "C"},
            {"time": 12.0, "label": "G"}
        ]"#;

        let seq = extract_chord_sequence(ref_json);
        assert_eq!(seq, vec!["Am", "F", "C", "G"]);

        let match_json = r#"[
            {"time": 0.0, "label": "Am"},
            {"time": 3.0, "label": "F"},
            {"time": 6.0, "label": "C"},
            {"time": 9.0, "label": "G"}
        ]"#;
        let sim = compare_chord_progressions(ref_json, match_json);
        assert!((sim - 1.0).abs() < 1e-6, "identical progressions should have 1.0 similarity: {sim}");

        let diff_json = r#"[
            {"time": 0.0, "label": "Dm"},
            {"time": 3.0, "label": "E7"}
        ]"#;
        let diff_sim = compare_chord_progressions(ref_json, diff_json);
        assert!(diff_sim < 0.2, "different progressions should have low similarity: {diff_sim}");
    }

    #[test]
    fn tests_daw_token_cleaning_and_matching() {
        let (score1, reason1) = calculate_name_match(
            "Midnight Ocean",
            "Midnight_Ocean_v1.m4a",
            "Midnight Ocean",
            "Midnight_Ocean_Mix_v2_24bit_Master.wav",
        );
        assert!(score1 >= 0.9, "expected high score for cleaned DAW tokens: {score1}");
        assert!(reason1.is_some());
    }

    #[test]
    fn scans_project_bounces_with_global_directories() {
        let root = std::env::temp_dir().join(format!("sw_global_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let bundle = root.join("Echoes.logicx");
        let global_dir = root.join("GlobalBounces");
        fs::create_dir_all(bundle.join("Bounces")).unwrap();
        fs::create_dir_all(&global_dir).unwrap();

        // Local bounce
        fs::write(bundle.join("Bounces/Echoes_Rough.wav"), "fake").unwrap();
        // Global bounce matching project name
        fs::write(global_dir.join("Echoes_Final_Mix_24bit.wav"), "fake").unwrap();
        // Unrelated global bounce
        fs::write(global_dir.join("AnotherSong_Mix.wav"), "fake").unwrap();

        let bounces = scan_project_bounces_with_globals(&bundle, &[global_dir]).unwrap();
        let names: Vec<_> = bounces.iter().map(|b| b.name.as_str()).collect();

        assert!(names.contains(&"Echoes_Rough.wav"), "expected local bundle bounce: {names:?}");
        assert!(names.contains(&"Echoes_Final_Mix_24bit.wav"), "expected matched global bounce: {names:?}");
        assert!(!names.contains(&"AnotherSong_Mix.wav"), "unrelated global bounce should not match: {names:?}");

        let global_bounce = bounces.iter().find(|b| b.name == "Echoes_Final_Mix_24bit.wav").unwrap();
        assert_eq!(global_bounce.origin.as_deref(), Some("global"));

        let _ = fs::remove_dir_all(&root);
    }
}
