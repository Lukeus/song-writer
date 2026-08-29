//! SQLite persistence layer.
//!
//! The schema links a `Song` (lyrics + chords, stored as TipTap document JSON)
//! to an optional `LogicProject` (a scanned `.logicx` file on disk). The
//! connection is wrapped in a `Mutex` and held in Tauri's managed state so every
//! command can borrow it safely.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Managed state: a single SQLite connection behind a mutex.
pub struct Db(pub Mutex<Connection>);

/// A song: lyrics and chords plus an optional link to a Logic project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Song {
    pub id: i64,
    pub title: String,
    /// Serialized TipTap/ProseMirror document JSON (the editor's source of truth).
    pub content_json: String,
    pub created_at: String,
    pub updated_at: String,
    /// `logic_projects.id` this song is linked to, if any.
    pub logic_project_id: Option<i64>,
}

/// A music file referenced (in place) by its path, plus any analysis results.
///
/// The file is never copied; we only persist its path and metadata. Analysis
/// columns are populated by the audio-analysis utility and are `None` until a
/// successful run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFile {
    pub id: i64,
    /// Absolute path to the audio file on disk (unique).
    pub path: String,
    pub name: String,
    pub format: Option<String>,
    pub size_bytes: Option<i64>,
    pub imported_at: String,
    /// `pending` | `running` | `done` | `error`.
    pub analysis_status: String,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub duration_secs: Option<f64>,
    /// JSON array of `{ "time": f64, "label": String }`, when analyzed.
    pub chords_json: Option<String>,
    pub analyzer_error: Option<String>,
    pub analyzed_at: Option<String>,
    /// `pending` | `running` | `done` | `error` — independent of `analysis_status`
    /// so a file can have chords analyzed but lyrics not (or vice-versa).
    pub transcription_status: String,
    /// Plain-text lyrics (newline-separated), once transcribed.
    pub lyrics: Option<String>,
    /// JSON array of `{ "start": f64, "end": f64, "text": String }`.
    pub lyrics_json: Option<String>,
    /// Detected language of the vocals (e.g. `en`).
    pub lyrics_language: Option<String>,
    pub transcription_error: Option<String>,
    pub transcribed_at: Option<String>,
    /// JSON array of compact 12-bit chroma hash integers for acoustic matching.
    pub fingerprint_json: Option<String>,
}

/// Successful analyzer output, persisted onto a [`MediaFile`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub duration_secs: Option<f64>,
    /// Raw JSON for the chord timeline (stored verbatim).
    pub chords_json: Option<String>,
    /// Raw JSON for acoustic chroma fingerprint (stored verbatim).
    pub fingerprint_json: Option<String>,
}

/// Successful transcription output, persisted onto a [`MediaFile`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionResult {
    /// Plain-text lyrics, newline-separated.
    pub lyrics: Option<String>,
    /// Raw JSON for the timestamped segment list (stored verbatim).
    pub lyrics_json: Option<String>,
    /// Detected language code (e.g. `en`).
    pub language: Option<String>,
}

/// A Logic Pro project as persisted in the catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicProjectRow {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub last_scanned_at: String,
}

/// A global directory scanned for Logic Pro audio bounces outside of `.logicx` bundles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BounceFolder {
    pub id: i64,
    pub path: String,
    pub created_at: String,
}

/// Open (or create) the database at `path` and run migrations.
pub fn init(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS logic_projects (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            path            TEXT NOT NULL UNIQUE,
            created_at      TEXT,
            modified_at     TEXT,
            last_scanned_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS songs (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            title            TEXT NOT NULL DEFAULT 'Untitled',
            content_json     TEXT NOT NULL DEFAULT '',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            logic_project_id INTEGER REFERENCES logic_projects(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_songs_logic_project
            ON songs(logic_project_id);

        -- Audio files referenced in place, plus their analysis results.
        CREATE TABLE IF NOT EXISTS media_files (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            path            TEXT NOT NULL UNIQUE,
            name            TEXT NOT NULL,
            format          TEXT,
            size_bytes      INTEGER,
            imported_at     TEXT NOT NULL,
            analysis_status TEXT NOT NULL DEFAULT 'pending',
            bpm             REAL,
            musical_key     TEXT,
            duration_secs   REAL,
            chords_json     TEXT,
            analyzer_error  TEXT,
            analyzed_at     TEXT,
            transcription_status TEXT NOT NULL DEFAULT 'pending',
            lyrics               TEXT,
            lyrics_json          TEXT,
            lyrics_language      TEXT,
            transcription_error  TEXT,
            transcribed_at       TEXT
        );

        -- Many-to-many: a song relates to many files, a file to many songs.
        CREATE TABLE IF NOT EXISTS song_media (
            song_id       INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
            media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
            PRIMARY KEY (song_id, media_file_id)
        );

        CREATE INDEX IF NOT EXISTS idx_song_media_song ON song_media(song_id);
        CREATE INDEX IF NOT EXISTS idx_song_media_media ON song_media(media_file_id);

        -- A configured language-model endpoint. `kind` selects the Rust impl
        -- (`ai::build_provider`); everything else is per-instance config.
        CREATE TABLE IF NOT EXISTS ai_providers (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL,
            label        TEXT NOT NULL,
            base_url     TEXT NOT NULL,
            model        TEXT,
            options_json TEXT,
            is_default   INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT NOT NULL
        );

        -- A chat thread. `song_id` is NULL for library-wide conversations, so
        -- the same table backs both the per-song agent and the (later)
        -- multi-song review.
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
            provider_id INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
            model       TEXT NOT NULL,
            title       TEXT NOT NULL DEFAULT 'New chat',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_conversations_song
            ON ai_conversations(song_id);

        CREATE TABLE IF NOT EXISTS ai_messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL
                            REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            thinking        TEXT,
            tool_calls_json TEXT,
            created_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
            ON ai_messages(conversation_id);

        CREATE TABLE IF NOT EXISTS global_bounce_folders (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            path       TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    seed_default_provider(conn)?;

    // Additively bring pre-existing `media_files` tables up to the current
    // schema. `CREATE TABLE IF NOT EXISTS` won't add columns to a table that
    // already exists, so we add the transcription columns here if missing.
    ensure_media_columns(conn)
}

/// Add any lyric/transcription columns that an older database is missing.
/// Each `ADD COLUMN` is idempotent — a "duplicate column name" error (the
/// column already exists) is expected and ignored.
fn ensure_media_columns(conn: &Connection) -> Result<(), String> {
    let columns = [
        ("transcription_status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("lyrics", "TEXT"),
        ("lyrics_json", "TEXT"),
        ("lyrics_language", "TEXT"),
        ("transcription_error", "TEXT"),
        ("transcribed_at", "TEXT"),
        ("fingerprint_json", "TEXT"),
    ];
    for (name, ty) in columns {
        let sql = format!("ALTER TABLE media_files ADD COLUMN {name} {ty}");
        match conn.execute(&sql, []) {
            Ok(_) => {}
            Err(e) if e.to_string().contains("duplicate column name") => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

pub fn create_song(conn: &Connection, title: &str, content_json: &str) -> Result<Song, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO songs (title, content_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![title, content_json, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    get_song(conn, id)
}

pub fn get_song(conn: &Connection, id: i64) -> Result<Song, String> {
    conn.query_row(
        "SELECT id, title, content_json, created_at, updated_at, logic_project_id
         FROM songs WHERE id = ?1",
        params![id],
        row_to_song,
    )
    .map_err(|e| e.to_string())
}

pub fn list_songs(conn: &Connection) -> Result<Vec<Song>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content_json, created_at, updated_at, logic_project_id
             FROM songs ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_song)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn update_song(
    conn: &Connection,
    id: i64,
    title: &str,
    content_json: &str,
) -> Result<Song, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE songs SET title = ?2, content_json = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, title, content_json, now],
    )
    .map_err(|e| e.to_string())?;
    get_song(conn, id)
}

pub fn delete_song(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM songs WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Link (or, with `None`, unlink) a song to a Logic project.
pub fn link_song_to_project(
    conn: &Connection,
    song_id: i64,
    logic_project_id: Option<i64>,
) -> Result<Song, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE songs SET logic_project_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![song_id, logic_project_id, now],
    )
    .map_err(|e| e.to_string())?;
    get_song(conn, song_id)
}

fn row_to_song(row: &rusqlite::Row) -> rusqlite::Result<Song> {
    Ok(Song {
        id: row.get(0)?,
        title: row.get(1)?,
        content_json: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        logic_project_id: row.get(5)?,
    })
}

// ---------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------

/// Columns selected by [`row_to_media`], in order.
const MEDIA_COLS: &str = "id, path, name, format, size_bytes, imported_at,
    analysis_status, bpm, musical_key, duration_secs, chords_json,
    analyzer_error, analyzed_at, transcription_status, lyrics, lyrics_json,
    lyrics_language, transcription_error, transcribed_at, fingerprint_json";

/// Register a media file by path, or return the existing row if already known.
///
/// Metadata (name/format/size) is refreshed on conflict, but analysis columns
/// are left untouched so a re-import does not wipe prior results.
pub fn import_media_file(
    conn: &Connection,
    path: &str,
    name: &str,
    format: Option<&str>,
    size_bytes: Option<i64>,
) -> Result<MediaFile, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO media_files (path, name, format, size_bytes, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
             name       = excluded.name,
             format     = excluded.format,
             size_bytes = excluded.size_bytes",
        params![path, name, format, size_bytes, now],
    )
    .map_err(|e| e.to_string())?;
    get_media_file_by_path(conn, path)
}

pub fn get_media_file(conn: &Connection, id: i64) -> Result<MediaFile, String> {
    conn.query_row(
        &format!("SELECT {MEDIA_COLS} FROM media_files WHERE id = ?1"),
        params![id],
        row_to_media,
    )
    .map_err(|e| e.to_string())
}

fn get_media_file_by_path(conn: &Connection, path: &str) -> Result<MediaFile, String> {
    conn.query_row(
        &format!("SELECT {MEDIA_COLS} FROM media_files WHERE path = ?1"),
        params![path],
        row_to_media,
    )
    .map_err(|e| e.to_string())
}

/// Associate a media file with a song (idempotent).
pub fn associate_media(conn: &Connection, song_id: i64, media_file_id: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO song_media (song_id, media_file_id) VALUES (?1, ?2)",
        params![song_id, media_file_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove the association between a song and a media file (the file row and the
/// file on disk are left intact).
pub fn dissociate_media(conn: &Connection, song_id: i64, media_file_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM song_media WHERE song_id = ?1 AND media_file_id = ?2",
        params![song_id, media_file_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// All media files associated with a song, most recently imported first.
pub fn list_song_media(conn: &Connection, song_id: i64) -> Result<Vec<MediaFile>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MEDIA_COLS} FROM media_files m
             JOIN song_media sm ON sm.media_file_id = m.id
             WHERE sm.song_id = ?1
             ORDER BY m.imported_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![song_id], row_to_media)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Mark a file's analysis state. Clears `analyzer_error` unless one is given.
pub fn set_analysis_status(
    conn: &Connection,
    media_file_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<MediaFile, String> {
    conn.execute(
        "UPDATE media_files SET analysis_status = ?2, analyzer_error = ?3 WHERE id = ?1",
        params![media_file_id, status, error],
    )
    .map_err(|e| e.to_string())?;
    get_media_file(conn, media_file_id)
}

/// Persist a successful analysis run and flip status to `done`.
pub fn save_analysis(
    conn: &Connection,
    media_file_id: i64,
    result: &AnalysisResult,
) -> Result<MediaFile, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_files SET
             analysis_status   = 'done',
             bpm               = ?2,
             musical_key       = ?3,
             duration_secs     = ?4,
             chords_json       = ?5,
             fingerprint_json  = ?6,
             analyzer_error    = NULL,
             analyzed_at       = ?7
         WHERE id = ?1",
        params![
            media_file_id,
            result.bpm,
            result.key,
            result.duration_secs,
            result.chords_json,
            result.fingerprint_json,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    get_media_file(conn, media_file_id)
}

/// Mark a file's transcription state. Clears `transcription_error` unless given.
pub fn set_transcription_status(
    conn: &Connection,
    media_file_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<MediaFile, String> {
    conn.execute(
        "UPDATE media_files SET transcription_status = ?2, transcription_error = ?3 WHERE id = ?1",
        params![media_file_id, status, error],
    )
    .map_err(|e| e.to_string())?;
    get_media_file(conn, media_file_id)
}

/// Persist a successful transcription run and flip status to `done`.
pub fn save_transcription(
    conn: &Connection,
    media_file_id: i64,
    result: &TranscriptionResult,
) -> Result<MediaFile, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE media_files SET
             transcription_status = 'done',
             lyrics               = ?2,
             lyrics_json          = ?3,
             lyrics_language      = ?4,
             transcription_error  = NULL,
             transcribed_at       = ?5
         WHERE id = ?1",
        params![
            media_file_id,
            result.lyrics,
            result.lyrics_json,
            result.language,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    get_media_file(conn, media_file_id)
}

/// Delete a media file row entirely (cascades to `song_media`). The file on
/// disk is not touched.
pub fn delete_media_file(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM media_files WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_media(row: &rusqlite::Row) -> rusqlite::Result<MediaFile> {
    Ok(MediaFile {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        format: row.get(3)?,
        size_bytes: row.get(4)?,
        imported_at: row.get(5)?,
        analysis_status: row.get(6)?,
        bpm: row.get(7)?,
        musical_key: row.get(8)?,
        duration_secs: row.get(9)?,
        chords_json: row.get(10)?,
        analyzer_error: row.get(11)?,
        analyzed_at: row.get(12)?,
        transcription_status: row.get(13)?,
        lyrics: row.get(14)?,
        lyrics_json: row.get(15)?,
        lyrics_language: row.get(16)?,
        transcription_error: row.get(17)?,
        transcribed_at: row.get(18)?,
        fingerprint_json: row.get(19)?,
    })
}

/// All media files in the database.
pub fn list_all_media_files(conn: &Connection) -> Result<Vec<MediaFile>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT {MEDIA_COLS} FROM media_files ORDER BY imported_at DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_media)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Logic projects
// ---------------------------------------------------------------------------

/// Insert each scanned project, or update its metadata if the path is already
/// known. Returns the full, current catalog.
pub fn upsert_logic_projects(
    conn: &mut Connection,
    projects: &[crate::logic::LogicProject],
) -> Result<Vec<LogicProjectRow>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for p in projects {
        tx.execute(
            "INSERT INTO logic_projects (name, path, created_at, modified_at, last_scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                 name            = excluded.name,
                 created_at      = excluded.created_at,
                 modified_at     = excluded.modified_at,
                 last_scanned_at = excluded.last_scanned_at",
            params![p.name, p.path, p.created_at, p.modified_at, now],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    list_logic_projects(conn)
}

pub fn list_logic_projects(conn: &Connection) -> Result<Vec<LogicProjectRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, created_at, modified_at, last_scanned_at
             FROM logic_projects ORDER BY modified_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LogicProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
                modified_at: row.get(4)?,
                last_scanned_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// AI providers / conversations / messages
// ---------------------------------------------------------------------------

/// A configured language-model endpoint. `kind` picks the Rust implementation;
/// `model` is the last model chosen for this provider (remembered across runs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProvider {
    pub id: i64,
    /// `ollama` today; new vendors add a `kind` and a `Provider` impl.
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub model: Option<String>,
    /// Free-form provider-specific JSON (unused by Ollama).
    pub options_json: Option<String>,
    pub is_default: bool,
    pub created_at: String,
}

/// A chat thread, scoped to a song or (with `song_id = None`) to the library.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub song_id: Option<i64>,
    pub provider_id: Option<i64>,
    pub model: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One turn in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiMessage {
    pub id: i64,
    pub conversation_id: i64,
    /// `user` | `assistant` (`tool` arrives with the agent loop).
    pub role: String,
    pub content: String,
    /// Reasoning emitted by thinking-capable models, kept out of `content`.
    pub thinking: Option<String>,
    /// Reserved for the tool-calling loop; always `None` today.
    pub tool_calls_json: Option<String>,
    pub created_at: String,
}

/// Ollama on its default port, inserted once so the feature works with no setup.
const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";

/// Insert the built-in local-Ollama provider the first time the DB is opened.
/// Later runs leave the table alone, so a user who edited or deleted it keeps
/// their choice.
fn seed_default_provider(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM ai_providers", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_providers (kind, label, base_url, is_default, created_at)
         VALUES ('ollama', 'Local Ollama', ?1, 1, ?2)",
        params![DEFAULT_OLLAMA_URL, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

const PROVIDER_COLS: &str =
    "id, kind, label, base_url, model, options_json, is_default, created_at";

pub fn list_ai_providers(conn: &Connection) -> Result<Vec<AiProvider>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PROVIDER_COLS} FROM ai_providers ORDER BY is_default DESC, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_provider)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get_ai_provider(conn: &Connection, id: i64) -> Result<AiProvider, String> {
    conn.query_row(
        &format!("SELECT {PROVIDER_COLS} FROM ai_providers WHERE id = ?1"),
        params![id],
        row_to_provider,
    )
    .map_err(|e| e.to_string())
}

/// The provider marked default, falling back to the lowest id.
pub fn default_ai_provider(conn: &Connection) -> Result<AiProvider, String> {
    conn.query_row(
        &format!(
            "SELECT {PROVIDER_COLS} FROM ai_providers
             ORDER BY is_default DESC, id LIMIT 1"
        ),
        [],
        row_to_provider,
    )
    .map_err(|_| "no AI provider configured".to_string())
}

pub fn create_ai_provider(
    conn: &Connection,
    kind: &str,
    label: &str,
    base_url: &str,
    model: Option<&str>,
) -> Result<AiProvider, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_providers (kind, label, base_url, model, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, label, base_url, model, now],
    )
    .map_err(|e| e.to_string())?;
    get_ai_provider(conn, conn.last_insert_rowid())
}

/// Update a provider's editable fields; `None` leaves a field unchanged.
pub fn update_ai_provider(
    conn: &Connection,
    id: i64,
    label: Option<&str>,
    base_url: Option<&str>,
    model: Option<&str>,
) -> Result<AiProvider, String> {
    conn.execute(
        "UPDATE ai_providers SET
             label    = COALESCE(?2, label),
             base_url = COALESCE(?3, base_url),
             model    = COALESCE(?4, model)
         WHERE id = ?1",
        params![id, label, base_url, model],
    )
    .map_err(|e| e.to_string())?;
    get_ai_provider(conn, id)
}

/// Mark one provider default, clearing the flag on all others.
pub fn set_default_ai_provider(conn: &Connection, id: i64) -> Result<AiProvider, String> {
    conn.execute(
        "UPDATE ai_providers SET is_default = CASE id WHEN ?1 THEN 1 ELSE 0 END",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    get_ai_provider(conn, id)
}

pub fn delete_ai_provider(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_provider(row: &rusqlite::Row) -> rusqlite::Result<AiProvider> {
    Ok(AiProvider {
        id: row.get(0)?,
        kind: row.get(1)?,
        label: row.get(2)?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        options_json: row.get(5)?,
        is_default: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

const CONVERSATION_COLS: &str =
    "id, song_id, provider_id, model, title, created_at, updated_at";

pub fn create_ai_conversation(
    conn: &Connection,
    song_id: Option<i64>,
    provider_id: i64,
    model: &str,
) -> Result<AiConversation, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_conversations (song_id, provider_id, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![song_id, provider_id, model, now],
    )
    .map_err(|e| e.to_string())?;
    get_ai_conversation(conn, conn.last_insert_rowid())
}

pub fn get_ai_conversation(conn: &Connection, id: i64) -> Result<AiConversation, String> {
    conn.query_row(
        &format!("SELECT {CONVERSATION_COLS} FROM ai_conversations WHERE id = ?1"),
        params![id],
        row_to_conversation,
    )
    .map_err(|e| e.to_string())
}

/// Conversations for a song, or the library-wide ones when `song_id` is `None`.
pub fn list_ai_conversations(
    conn: &Connection,
    song_id: Option<i64>,
) -> Result<Vec<AiConversation>, String> {
    let sql = format!(
        "SELECT {CONVERSATION_COLS} FROM ai_conversations
         WHERE song_id IS ?1 ORDER BY updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![song_id], row_to_conversation)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Bump `updated_at`, and set the title if it is still the placeholder.
pub fn touch_ai_conversation(
    conn: &Connection,
    id: i64,
    title_if_unset: Option<&str>,
) -> Result<AiConversation, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE ai_conversations SET
             updated_at = ?2,
             title = CASE WHEN title = 'New chat' AND ?3 IS NOT NULL
                          THEN ?3 ELSE title END
         WHERE id = ?1",
        params![id, now, title_if_unset],
    )
    .map_err(|e| e.to_string())?;
    get_ai_conversation(conn, id)
}

/// Switch the model a conversation uses for subsequent turns.
pub fn set_ai_conversation_model(
    conn: &Connection,
    id: i64,
    model: &str,
) -> Result<AiConversation, String> {
    conn.execute(
        "UPDATE ai_conversations SET model = ?2 WHERE id = ?1",
        params![id, model],
    )
    .map_err(|e| e.to_string())?;
    get_ai_conversation(conn, id)
}

pub fn delete_ai_conversation(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_conversation(row: &rusqlite::Row) -> rusqlite::Result<AiConversation> {
    Ok(AiConversation {
        id: row.get(0)?,
        song_id: row.get(1)?,
        provider_id: row.get(2)?,
        model: row.get(3)?,
        title: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const MESSAGE_COLS: &str =
    "id, conversation_id, role, content, thinking, tool_calls_json, created_at";

pub fn add_ai_message(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &str,
    thinking: Option<&str>,
) -> Result<AiMessage, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_messages (conversation_id, role, content, thinking, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conversation_id, role, content, thinking, now],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {MESSAGE_COLS} FROM ai_messages WHERE id = ?1"),
        params![conn.last_insert_rowid()],
        row_to_ai_message,
    )
    .map_err(|e| e.to_string())
}

pub fn list_ai_messages(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Vec<AiMessage>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MESSAGE_COLS} FROM ai_messages
             WHERE conversation_id = ?1 ORDER BY id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], row_to_ai_message)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Delete a message and everything after it — used to retry a turn.
pub fn truncate_ai_messages_from(conn: &Connection, message_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ai_messages
         WHERE conversation_id = (SELECT conversation_id FROM ai_messages WHERE id = ?1)
           AND id >= ?1",
        params![message_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_ai_message(row: &rusqlite::Row) -> rusqlite::Result<AiMessage> {
    Ok(AiMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        thinking: row.get(4)?,
        tool_calls_json: row.get(5)?,
        created_at: row.get(6)?,
    })
}

// ---------------------------------------------------------------------------
// Global Bounce Folders
// ---------------------------------------------------------------------------

pub fn add_global_bounce_folder(conn: &Connection, path: &str) -> Result<BounceFolder, String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO global_bounce_folders (path, created_at) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET created_at = excluded.created_at",
        params![path, now],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, path, created_at FROM global_bounce_folders WHERE path = ?1",
        params![path],
        row_to_bounce_folder,
    )
    .map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub fn get_global_bounce_folder(conn: &Connection, id: i64) -> Result<BounceFolder, String> {
    conn.query_row(
        "SELECT id, path, created_at FROM global_bounce_folders WHERE id = ?1",
        params![id],
        row_to_bounce_folder,
    )
    .map_err(|e| e.to_string())
}

pub fn list_global_bounce_folders(conn: &Connection) -> Result<Vec<BounceFolder>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path, created_at FROM global_bounce_folders ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_bounce_folder)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn delete_global_bounce_folder(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM global_bounce_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_bounce_folder(row: &rusqlite::Row) -> rusqlite::Result<BounceFolder> {
    Ok(BounceFolder {
        id: row.get(0)?,
        path: row.get(1)?,
        created_at: row.get(2)?,
    })
}

