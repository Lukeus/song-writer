mod ai;
mod commands;
mod db;
mod logic;
mod utilities;

use ai::AiState;
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
            // Registry of in-flight AI runs, so generations can be cancelled.
            app.manage(AiState::default());
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
            ai::commands::ai_list_providers,
            ai::commands::ai_default_provider,
            ai::commands::ai_create_provider,
            ai::commands::ai_update_provider,
            ai::commands::ai_set_default_provider,
            ai::commands::ai_delete_provider,
            ai::commands::ai_provider_health,
            ai::commands::ai_list_models,
            ai::commands::ai_list_conversations,
            ai::commands::ai_create_conversation,
            ai::commands::ai_set_conversation_model,
            ai::commands::ai_delete_conversation,
            ai::commands::ai_list_messages,
            ai::commands::ai_song_context,
            ai::commands::ai_parse_lyrics,
            ai::commands::ai_proposed_edit,
            ai::commands::ai_send_message,
            ai::commands::ai_cancel_run,
            ai::commands::ai_truncate_from,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
