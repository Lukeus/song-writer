mod ai;
mod commands;
mod db;
mod logic;
mod midi;
mod utilities;

use ai::AiState;
use db::Db;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "macos")]
fn fix_path_env() {
    let home = std::env::var("HOME").unwrap_or_default();
    let common_paths = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    let user_paths = [
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
    ];

    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = current.split(':').map(|s| s.to_string()).collect();

    for p in common_paths.iter().map(|s| s.to_string()).chain(user_paths) {
        if !p.is_empty() && std::path::Path::new(&p).exists() && !parts.contains(&p) {
            parts.insert(0, p);
        }
    }

    std::env::set_var("PATH", parts.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    fix_path_env();

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
                .map_err(std::io::Error::other)?;
            app.manage(Db(Mutex::new(conn)));
            // Registry of in-flight AI runs, so generations can be cancelled.
            app.manage(AiState::default());
            // Registry for in-flight waveform search cancellation.
            app.manage(logic::WaveformSearchState::default());
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
            commands::open_logic_project,
            commands::list_project_bounces,
            commands::get_logic_project_details,
            commands::find_matching_logic_projects,
            commands::cancel_waveform_search,
            commands::export_song_midi,
            commands::list_global_bounce_folders,
            commands::add_global_bounce_folder,
            commands::delete_global_bounce_folder,
            utilities::audio::import_audio_file,
            utilities::audio::list_song_media,
            utilities::audio::dissociate_media,
            utilities::audio::delete_media_file,
            utilities::audio::analyze_media,
            utilities::audio::transcribe_media,
            utilities::mastering::meter_master,
            utilities::mastering::render_master,
            utilities::mastering::render_master_with_eq,
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
