//! Audio-analysis utility commands.
//!
//! Music files are referenced **in place** (we store the path, never a copy) and
//! associated to songs many-to-many. Analysis runs a bundled Python sidecar
//! (`analyzer`) that prints JSON describing BPM / key / chords. In debug builds,
//! if the sidecar binary is not present we fall back to running the source
//! `analyze.py` with the system `python3`, so the feature is testable before the
//! PyInstaller sidecar is packaged.

use crate::db::{self, AnalysisResult, Db, MediaFile, TranscriptionResult};
use serde::Deserialize;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

/// Shape of the analyzer's JSON stdout on success.
#[derive(Debug, Deserialize)]
struct AnalyzerOutput {
    bpm: Option<f64>,
    key: Option<String>,
    duration_secs: Option<f64>,
    /// Passed through verbatim; re-serialized for storage.
    chords: Option<serde_json::Value>,
    /// Present (with a message) when the analyzer failed internally.
    error: Option<String>,
}

/// Shape of the transcriber's JSON stdout on success.
#[derive(Debug, Deserialize)]
struct TranscriberOutput {
    /// Detected language code (e.g. `en`).
    language: Option<String>,
    /// Newline-separated plain-text lyrics.
    lyrics: Option<String>,
    /// Timestamped segments; passed through verbatim and re-serialized.
    segments: Option<serde_json::Value>,
    /// Present (with a message) when the transcriber failed internally.
    error: Option<String>,
}

/// Register an audio file (by path) and associate it with `song_id`.
#[tauri::command]
pub fn import_audio_file(db: State<Db>, song_id: i64, path: String) -> Result<MediaFile, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string();
    let format = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());
    let size_bytes = std::fs::metadata(p).ok().map(|m| m.len() as i64);

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let media = db::import_media_file(&conn, &path, &name, format.as_deref(), size_bytes)?;
    db::associate_media(&conn, song_id, media.id)?;
    Ok(media)
}

/// Media files associated with a song.
#[tauri::command]
pub fn list_song_media(db: State<Db>, song_id: i64) -> Result<Vec<MediaFile>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_song_media(&conn, song_id)
}

/// Remove a file from a song (keeps the file row and the file on disk).
#[tauri::command]
pub fn dissociate_media(db: State<Db>, song_id: i64, media_file_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::dissociate_media(&conn, song_id, media_file_id)
}

/// Delete a media file row entirely (cascades to all associations).
#[tauri::command]
pub fn delete_media_file(db: State<Db>, media_file_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_media_file(&conn, media_file_id)
}

/// Run the analyzer on a media file and persist the results.
///
/// The DB lock is never held across the (async) analyzer run: we read the path
/// and mark `running`, drop the lock, await the sidecar, then re-lock to save.
#[tauri::command]
pub async fn analyze_media(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
) -> Result<MediaFile, String> {
    let path = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let media = db::get_media_file(&conn, media_file_id)?;
        db::set_analysis_status(&conn, media_file_id, "running", None)?;
        media.path
    };

    if !Path::new(&path).is_file() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        return db::set_analysis_status(
            &conn,
            media_file_id,
            "error",
            Some(&format!("file not found: {path}")),
        );
    }

    let outcome = run_analyzer(&app, &path).await;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match outcome {
        Ok(out) if out.error.is_none() => {
            let chords_json = out
                .chords
                .map(|c| serde_json::to_string(&c).unwrap_or_else(|_| "[]".into()));
            let result = AnalysisResult {
                bpm: out.bpm,
                key: out.key,
                duration_secs: out.duration_secs,
                chords_json,
            };
            db::save_analysis(&conn, media_file_id, &result)
        }
        Ok(out) => db::set_analysis_status(
            &conn,
            media_file_id,
            "error",
            Some(&out.error.unwrap_or_else(|| "analyzer error".into())),
        ),
        Err(e) => db::set_analysis_status(&conn, media_file_id, "error", Some(&e)),
    }
}

/// Transcribe a media file's vocals into lyrics and persist the result.
///
/// Mirrors [`analyze_media`]: read the path and mark `running`, drop the DB
/// lock, await the transcriber sidecar, then re-lock to save. Transcription
/// status is tracked separately from analysis, so a file can have chords but no
/// lyrics (or vice-versa).
#[tauri::command]
pub async fn transcribe_media(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
) -> Result<MediaFile, String> {
    let path = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let media = db::get_media_file(&conn, media_file_id)?;
        db::set_transcription_status(&conn, media_file_id, "running", None)?;
        media.path
    };

    if !Path::new(&path).is_file() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        return db::set_transcription_status(
            &conn,
            media_file_id,
            "error",
            Some(&format!("file not found: {path}")),
        );
    }

    let outcome = run_transcriber(&app, &path).await;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match outcome {
        Ok(out) if out.error.is_none() => {
            let lyrics_json = out
                .segments
                .map(|s| serde_json::to_string(&s).unwrap_or_else(|_| "[]".into()));
            let result = TranscriptionResult {
                lyrics: out.lyrics,
                lyrics_json,
                language: out.language,
            };
            db::save_transcription(&conn, media_file_id, &result)
        }
        Ok(out) => db::set_transcription_status(
            &conn,
            media_file_id,
            "error",
            Some(&out.error.unwrap_or_else(|| "transcriber error".into())),
        ),
        Err(e) => db::set_transcription_status(&conn, media_file_id, "error", Some(&e)),
    }
}

/// Invoke the transcriber for `path`, returning its parsed JSON output.
async fn run_transcriber(app: &AppHandle, path: &str) -> Result<TranscriberOutput, String> {
    let (stdout, stderr, code) = run_sidecar(app, "transcribe.py", "transcriber", &[path]).await?;
    if let Ok(parsed) = serde_json::from_str::<TranscriberOutput>(stdout.trim()) {
        return Ok(parsed);
    }
    Err(format!(
        "could not parse transcriber output (exit {code:?}). stderr: {}",
        stderr.trim()
    ))
}

/// Invoke the analyzer for `path`, returning its parsed JSON output.
async fn run_analyzer(app: &AppHandle, path: &str) -> Result<AnalyzerOutput, String> {
    let (stdout, stderr, code) = run_sidecar(app, "analyze.py", "analyzer", &[path]).await?;
    if let Ok(parsed) = serde_json::from_str::<AnalyzerOutput>(stdout.trim()) {
        return Ok(parsed);
    }
    Err(format!(
        "could not parse analyzer output (exit {code:?}). stderr: {}",
        stderr.trim()
    ))
}

/// Run a Python sidecar utility on `args`, returning `(stdout, stderr, exit_code)`.
///
/// In **debug** builds we run the source `script_file` (e.g. `analyze.py`) from
/// the `analyzer/` dir with the project venv's `python3` — resolved from the
/// compile-time crate dir, since Tauri relocates the sidecar binary at runtime
/// and the Tauri process does not inherit an interactively-activated venv. In
/// **release** builds we run the bundled `sidecar` binary (e.g. `analyzer`).
async fn run_sidecar(
    app: &AppHandle,
    script_file: &str,
    sidecar: &str,
    args: &[&str],
) -> Result<(String, String, Option<i32>), String> {
    let output = if cfg!(debug_assertions) {
        let script = format!(
            "{}/../analyzer/{script_file}",
            env!("CARGO_MANIFEST_DIR")
        );
        let venv_python = concat!(env!("CARGO_MANIFEST_DIR"), "/../venv/bin/python3");
        let python = if std::path::Path::new(venv_python).exists() {
            venv_python
        } else {
            "python3"
        };
        let mut cmd_args = vec![script.as_str()];
        cmd_args.extend_from_slice(args);
        app.shell()
            .command(python)
            .args(cmd_args)
            .output()
            .await
            .map_err(|e| format!("python3 {script_file} failed: {e}"))?
    } else {
        app.shell()
            .sidecar(sidecar)
            .map_err(|e| format!("{sidecar} sidecar unavailable: {e}"))?
            .args(args.to_vec())
            .output()
            .await
            .map_err(|e| e.to_string())?
    };

    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code(),
    ))
}
