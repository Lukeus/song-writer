mod commands;
mod db;
mod logic;
mod utilities;

use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Store the SQLite file in the platform app-data dir, e.g.
            // ~/Library/Application Support/com.lukeusadams.song-writer/songwriter.db
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::init(&dir.join("songwriter.db"))
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_song,
            commands::list_songs,
            commands::get_song,
            commands::update_song,
            commands::delete_song,
            commands::link_song_to_project,
            commands::scan_logic_projects,
            commands::list_logic_projects,
            utilities::audio::import_audio_file,
            utilities::audio::list_song_media,
            utilities::audio::dissociate_media,
            utilities::audio::delete_media_file,
            utilities::audio::analyze_media,
            utilities::audio::transcribe_media,
            utilities::mastering::meter_master,
            utilities::mastering::render_master,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
