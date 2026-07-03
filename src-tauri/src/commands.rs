//! Tauri commands — the bridge the React frontend calls via `invoke()`.
//!
//! Each command locks the managed DB connection, does its work, and returns a
//! `Result<_, String>` so errors surface as rejected promises on the JS side.

use crate::db::{self, Db, LogicProjectRow, Song};
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
