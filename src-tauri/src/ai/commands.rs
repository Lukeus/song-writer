//! Tauri commands for the AI layer.
//!
//! The DB mutex is **never** held across an `await`: each command reads what it
//! needs, drops the lock, does its network work, then re-locks to persist —
//! the same discipline `utilities::audio` follows for sidecar runs.

use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::State;

use super::{build_provider, context, AiState, ChatMessage, ChatRequest, ModelInfo, StreamEvent};
use crate::db::{self, AiConversation, AiMessage, AiProvider, Db};

/// Longest a generated conversation title may be before it is elided.
const TITLE_MAX: usize = 48;

// ---- Providers -----------------------------------------------------------

#[tauri::command]
pub fn ai_list_providers(db: State<Db>) -> Result<Vec<AiProvider>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_ai_providers(&conn)
}

#[tauri::command]
pub fn ai_default_provider(db: State<Db>) -> Result<AiProvider, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::default_ai_provider(&conn)
}

#[tauri::command]
pub fn ai_create_provider(
    db: State<Db>,
    kind: String,
    label: String,
    base_url: String,
    model: Option<String>,
) -> Result<AiProvider, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::create_ai_provider(&conn, &kind, &label, &base_url, model.as_deref())
}

#[tauri::command]
pub fn ai_update_provider(
    db: State<Db>,
    id: i64,
    label: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<AiProvider, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::update_ai_provider(
        &conn,
        id,
        label.as_deref(),
        base_url.as_deref(),
        model.as_deref(),
    )
}

#[tauri::command]
pub fn ai_set_default_provider(db: State<Db>, id: i64) -> Result<AiProvider, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::set_default_ai_provider(&conn, id)
}

#[tauri::command]
pub fn ai_delete_provider(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_ai_provider(&conn, id)
}

/// Probe a provider. Returns a short status string, or an actionable error.
#[tauri::command]
pub async fn ai_provider_health(db: State<'_, Db>, id: Option<i64>) -> Result<String, String> {
    let row = load_provider(&db, id)?;
    build_provider(&row)?.health().await
}

/// Models the provider can currently serve, with their capabilities.
#[tauri::command]
pub async fn ai_list_models(
    db: State<'_, Db>,
    id: Option<i64>,
) -> Result<Vec<ModelInfo>, String> {
    let row = load_provider(&db, id)?;
    build_provider(&row)?.list_models().await
}

/// Read a provider row by id, or the default when `id` is `None`.
fn load_provider(db: &State<'_, Db>, id: Option<i64>) -> Result<AiProvider, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match id {
        Some(id) => db::get_ai_provider(&conn, id),
        None => db::default_ai_provider(&conn),
    }
}

// ---- Conversations -------------------------------------------------------

/// Conversations for a song, or the library-wide ones when `song_id` is null.
#[tauri::command]
pub fn ai_list_conversations(
    db: State<Db>,
    song_id: Option<i64>,
) -> Result<Vec<AiConversation>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_ai_conversations(&conn, song_id)
}

#[tauri::command]
pub fn ai_create_conversation(
    db: State<Db>,
    song_id: Option<i64>,
    provider_id: Option<i64>,
    model: String,
) -> Result<AiConversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let provider = match provider_id {
        Some(id) => db::get_ai_provider(&conn, id)?,
        None => db::default_ai_provider(&conn)?,
    };
    db::create_ai_conversation(&conn, song_id, provider.id, &model)
}

#[tauri::command]
pub fn ai_set_conversation_model(
    db: State<Db>,
    id: i64,
    model: String,
) -> Result<AiConversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::set_ai_conversation_model(&conn, id, &model)
}

#[tauri::command]
pub fn ai_delete_conversation(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::delete_ai_conversation(&conn, id)
}

#[tauri::command]
pub fn ai_list_messages(db: State<Db>, conversation_id: i64) -> Result<Vec<AiMessage>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::list_ai_messages(&conn, conversation_id)
}

// ---- Generation ----------------------------------------------------------

/// Append `content` as a user turn, stream the reply, and persist it.
///
/// `think` must be `Some` only for models advertising the `thinking`
/// capability — the frontend already has that from [`ai_list_models`], so we
/// take it on trust rather than spending a round-trip re-checking.
///
/// A cancelled run is not an error: whatever was generated before the stop is
/// saved, so a half-written verse is not lost. Returns `None` when a run was
/// stopped before producing anything — the user's turn stays on record, but no
/// empty reply is stored against it.
#[tauri::command]
pub async fn ai_send_message(
    db: State<'_, Db>,
    ai: State<'_, AiState>,
    conversation_id: i64,
    content: String,
    think: Option<bool>,
    on_event: Channel<StreamEvent>,
) -> Result<Option<AiMessage>, String> {
    // 1. Read state and record the user turn, then release the lock.
    let (provider_row, request) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let convo = db::get_ai_conversation(&conn, conversation_id)?;
        let provider_row = match convo.provider_id {
            Some(id) => db::get_ai_provider(&conn, id)?,
            None => db::default_ai_provider(&conn)?,
        };
        // Rebuilt every turn, so lyrics edited mid-conversation are current.
        let song_context = convo.song_id.and_then(|id| context::build(&conn, id));

        db::add_ai_message(&conn, conversation_id, "user", &content, None)?;
        db::touch_ai_conversation(&conn, conversation_id, Some(&derive_title(&content)))?;

        let history = db::list_ai_messages(&conn, conversation_id)?;
        let mut messages = vec![ChatMessage::new(
            "system",
            system_prompt(song_context.as_deref()),
        )];
        messages.extend(
            history
                .iter()
                // Reasoning is shown in the UI but not fed back to the model:
                // providers expect only role/content on the way in.
                .filter(|m| m.role == "user" || m.role == "assistant")
                .map(|m| ChatMessage::new(&m.role, m.content.clone())),
        );

        let request = ChatRequest {
            model: convo.model.clone(),
            messages,
            temperature: Some(0.8),
            think,
        };
        (provider_row, request)
    };

    // 2. Stream, with a cancellable run registered for the duration.
    let provider = build_provider(&provider_row)?;
    let (run_id, cancel) = ai.begin();
    let _ = on_event.send(StreamEvent::Started { run_id });

    let outcome = provider.chat_stream(request, &on_event, cancel.clone()).await;
    ai.end(run_id);

    // 3. Persist the reply.
    match outcome {
        Ok(out) => {
            let saved = if out.content.is_empty() && out.thinking.is_none() {
                None
            } else {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                let msg = db::add_ai_message(
                    &conn,
                    conversation_id,
                    "assistant",
                    &out.content,
                    out.thinking.as_deref(),
                )?;
                db::touch_ai_conversation(&conn, conversation_id, None)?;
                Some(msg)
            };
            let _ = on_event.send(StreamEvent::Done {
                content: out.content,
                thinking: out.thinking,
                cancelled: out.cancelled || cancel.load(Ordering::Relaxed),
            });
            Ok(saved)
        }
        Err(message) => {
            // The user turn stays on record so the message can be retried
            // without retyping it.
            let _ = on_event.send(StreamEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

/// Stop an in-flight run. Returns false if it had already finished.
#[tauri::command]
pub fn ai_cancel_run(ai: State<AiState>, run_id: u64) -> bool {
    ai.cancel(run_id)
}

/// Drop a message and everything after it, so a turn can be re-asked.
#[tauri::command]
pub fn ai_truncate_from(db: State<Db>, message_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::truncate_ai_messages_from(&conn, message_id)
}

/// The first line of the user's opening message, used as a conversation title.
fn derive_title(content: &str) -> String {
    let line = content.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= TITLE_MAX {
        return line.to_string();
    }
    let head: String = line.chars().take(TITLE_MAX).collect();
    format!("{}…", head.trim_end())
}

/// Instructions plus everything known about the open song.
///
/// The context block is the point of the feature: the model is looking at the
/// user's actual lyrics, chords, tempo and key, so it is told explicitly that
/// it can already see them — otherwise models reflexively ask the user to
/// paste in the lyrics that are sitting right there in the prompt.
fn system_prompt(song_context: Option<&str>) -> String {
    let mut p = String::from(
        "You are a songwriting collaborator inside a desktop lyric editor. \
         Help with lyrics, imagery, rhyme, song structure, and chord choices. \
         Be concrete and concise — offer usable lines, not essays. \
         When you suggest lyrics, give the lines plainly, without commentary \
         around them unless asked.\n\n\
         Chord notation: write a chord in square brackets immediately before \
         the syllable it lands on, with no space between them, like \
         [Bm]There is a [G]power in the peo[D]ple. The editor turns each one \
         into a chord positioned above that exact syllable, so put the bracket \
         where the change actually falls — mid-word when that is where it \
         belongs. Use this notation whenever you give chords with lyrics; when \
         asked for chords over existing lyrics, repeat the user's lines back \
         verbatim with the brackets added, changing no words.\n\n\
         Changing the song: when the user asks you to write, rewrite, chord or \
         otherwise edit the song itself, put the result in a fenced block \
         tagged `song`, like this:\n\n\
         ```song\n\
         [Bm]There is a [G]power in the peo[D]ple\n\
         [C]Connection is the pow[G]er we embrace\n\
         ```\n\n\
         That block replaces what is in the editor, so it must contain the \
         complete song exactly as it should now read — every section, in order, \
         even the parts you did not change. Never print a line twice (once \
         plain and once with chords): give only the final version of each line. \
         Keep all explanation outside the block, and use no markdown headings \
         inside it. If you are only chatting, answering a question, or offering \
         a single line to consider, do not use the block at all.",
    );
    match song_context {
        Some(ctx) => {
            p.push_str(
                "\n\nThe song the user is working on is reproduced in full below. \
                 You can already see it — never ask the user to paste their \
                 lyrics, and never claim you cannot see the song. Quote from it \
                 directly when discussing it. Anything not shown below is \
                 genuinely unknown to you: ask rather than invent.\n\n",
            );
            p.push_str(ctx);
        }
        None => p.push_str(
            "\n\nNo song is open, so you have no lyrics to work from — \
             ask the user what they are writing.",
        ),
    }
    p
}

/// The exact context block sent for a song, so the UI can show the user
/// precisely what the model is given.
#[tauri::command]
pub fn ai_song_context(db: State<Db>, song_id: i64) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(context::build(&conn, song_id))
}

/// Convert `[Bm]lyric` text into editor blocks, turning each chord into a real
/// inline node above its syllable. Used to drop the agent's output into the
/// song; a pure function, but it lives here so the notation has exactly one
/// definition, shared with the context the model is shown.
#[tauri::command]
pub fn ai_parse_lyrics(text: String) -> Vec<serde_json::Value> {
    context::parse_lyric_blocks(&text)
}

/// Pull a proposed song rewrite out of a reply, or `None` if it only chatted.
/// Only the fenced block is ever applied to the song — never the commentary
/// around it.
#[tauri::command]
pub fn ai_proposed_edit(text: String) -> Option<context::ProposedEdit> {
    context::parse_reply(&text)
}
