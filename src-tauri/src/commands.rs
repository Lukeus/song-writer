//! Tauri commands — the bridge the React frontend calls via `invoke()`.
//!
//! Each command locks the managed DB connection, does its work, and returns a
//! `Result<_, String>` so errors surface as rejected promises on the JS side.

use crate::db::{self, BounceFolder, Db, LogicProjectRow, Song};
use crate::logic;
use std::path::Path;
use tauri::State;

// ---- Songs ---------------------------------------------------------------

#[tauri::command]
pub fn create_song(db: State<Db>, title: String, content_json: String) -> Result<Song, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::create_song(&conn, &title, &content_json)
}

#[tauri::command]
pub fn list_songs(db: State<Db>) -> Result<Vec<Song>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_songs(&conn)
}

#[tauri::command]
pub fn get_song(db: State<Db>, id: i64) -> Result<Song, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::get_song(&conn, id)
}

#[tauri::command]
pub fn update_song(
    db: State<Db>,
    id: i64,
    title: String,
    content_json: String,
) -> Result<Song, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::update_song(&conn, id, &title, &content_json)
}

#[tauri::command]
pub fn delete_song(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_song(&conn, id)
}

#[tauri::command]
pub fn link_song_to_project(
    db: State<Db>,
    song_id: i64,
    logic_project_id: Option<i64>,
) -> Result<Song, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::link_song_to_project(&conn, song_id, logic_project_id)
}

// ---- Logic projects ------------------------------------------------------

/// Scan `directory` for `.logicx` bundles, persist them, and return the catalog.
#[tauri::command]
pub fn scan_logic_projects(db: State<Db>, directory: String) -> Result<Vec<LogicProjectRow>, String> {
    let found = logic::scan_logic_projects(Path::new(&directory))?;
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    db::upsert_logic_projects(&mut conn, &found)
}

/// Return the persisted catalog without rescanning the filesystem.
#[tauri::command]
pub fn list_logic_projects(db: State<Db>) -> Result<Vec<LogicProjectRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_logic_projects(&conn)
}

/// Open a Logic Pro project bundle in Logic Pro.
#[tauri::command]
pub fn open_logic_project(path: String) -> Result<(), String> {
    logic::open_logic_project(Path::new(&path))
}

/// Scan a Logic Pro project's bundle and directory for bounced audio files.
#[tauri::command]
pub fn list_project_bounces(
    db: State<Db>,
    project_path: String,
) -> Result<Vec<logic::ProjectBounce>, String> {
    let mut global_dirs = logic::discover_default_global_bounce_dirs();
    if let Ok(conn) = db.0.lock() {
        if let Ok(custom_dirs) = db::list_global_bounce_folders(&conn) {
            for d in custom_dirs {
                let p = Path::new(&d.path).to_path_buf();
                if !global_dirs.contains(&p) && p.exists() {
                    global_dirs.push(p);
                }
            }
        }
    }
    logic::scan_project_bounces_with_globals(Path::new(&project_path), &global_dirs)
}

/// Extract deep metadata from a `.logicx` project bundle, including alternatives and asset counts.
#[tauri::command]
pub fn get_logic_project_details(path: String) -> Result<logic::LogicProjectDetails, String> {
    logic::get_project_details(Path::new(&path))
}

/// Search all cataloged Logic Pro projects for audio waveform and metadata matches for a song.
#[tauri::command]
pub async fn find_matching_logic_projects(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    search_state: State<'_, logic::WaveformSearchState>,
    song_id: i64,
) -> Result<Vec<logic::AudioMatchResult>, String> {
    logic::find_matching_logic_projects(&app, &db, &search_state, song_id).await
}

/// Cancel an in-flight waveform search across Logic projects.
#[tauri::command]
pub fn cancel_waveform_search(search_state: State<'_, logic::WaveformSearchState>) -> bool {
    search_state.cancel();
    true
}

/// Export a song's chord progression and section markers as a Standard MIDI File (.mid).
#[tauri::command]
pub fn export_song_midi(
    db: State<Db>,
    song_id: i64,
    bpm: Option<f64>,
    destination_path: String,
) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let song = db::get_song(&conn, song_id)?;
    let lyrics = crate::ai::context::flatten_doc(&song.content_json);

    // If BPM not specified, try to use BPM from first analyzed media recording
    let media = db::list_song_media(&conn, song_id).unwrap_or_default();
    let effective_bpm = bpm.or_else(|| media.iter().find_map(|m| m.bpm));
    let effective_key = media.iter().find_map(|m| m.musical_key.as_deref());

    crate::midi::export_song_midi_file(
        &lyrics,
        effective_bpm,
        effective_key,
        Path::new(&destination_path),
    )
}

// ---- Global Bounce Folders -----------------------------------------------

#[tauri::command]
pub fn list_global_bounce_folders(db: State<Db>) -> Result<Vec<BounceFolder>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_global_bounce_folders(&conn)
}

#[tauri::command]
pub fn add_global_bounce_folder(db: State<Db>, path: String) -> Result<BounceFolder, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::add_global_bounce_folder(&conn, &path)
}

#[tauri::command]
pub fn delete_global_bounce_folder(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_global_bounce_folder(&conn, id)
}
