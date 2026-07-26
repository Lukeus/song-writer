//! AI provider layer.
//!
//! Everything the app asks of a language model goes through the [`Provider`]
//! trait, so supporting a new vendor means writing one impl and adding one arm
//! to [`build_provider`] — no caller changes. The first implementation is
//! [`ollama`] (local, no API key).
//!
//! Provider calls live in Rust rather than in the webview for three reasons:
//! Ollama's CORS policy rejects the Tauri origin, future providers' API keys
//! must never reach the frontend, and streaming is delivered over a Tauri
//! [`Channel`] rather than a browser `fetch` reader.

pub mod commands;
pub mod context;
pub mod ollama;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

use crate::db::AiProvider;

/// One turn sent to (or received from) a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `system` | `user` | `assistant`.
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: content.into(),
        }
    }
}

/// A model offered by a provider, with the features it advertises.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub parameter_size: Option<String>,
    /// Provider-reported features, e.g. `completion`, `tools`, `thinking`.
    /// The agent loop will require `tools`; the UI uses `thinking` to decide
    /// whether the reasoning toggle applies.
    pub capabilities: Vec<String>,
}

/// A single completion request.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    /// `Some` only for thinking-capable models — sending it to a model that
    /// cannot think is an error on some providers, so callers must check first.
    pub think: Option<bool>,
}

/// A frame of a streaming completion, pushed to the frontend over a channel.
///
/// `Started` always arrives first and carries the id needed to cancel the run;
/// exactly one of `Done` / `Error` arrives last.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    #[serde(rename_all = "camelCase")]
    Started { run_id: u64 },
    /// A chunk of the visible answer.
    Delta { text: String },
    /// A chunk of the model's reasoning, kept separate from the answer.
    Thinking { text: String },
    Done {
        content: String,
        thinking: Option<String>,
        cancelled: bool,
    },
    Error { message: String },
}

/// What a finished (or cancelled) run produced. A cancelled run still returns
/// the text generated so far — it is persisted rather than thrown away.
#[derive(Debug, Clone, Default)]
pub struct ChatOutcome {
    pub content: String,
    pub thinking: Option<String>,
    pub cancelled: bool,
}

/// The single abstraction every AI vendor implements.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    /// Models this endpoint can serve right now.
    async fn list_models(&self) -> Result<Vec<ModelInfo>, String>;

    /// A short human-readable status, or an actionable error.
    async fn health(&self) -> Result<String, String>;

    /// Stream a completion, pushing [`StreamEvent`]s to `sink` as they arrive.
    ///
    /// Implementations must check `cancel` between chunks and return an outcome
    /// with `cancelled: true` (not an error) when it is set.
    async fn chat_stream(
        &self,
        req: ChatRequest,
        sink: &Channel<StreamEvent>,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatOutcome, String>;
}

/// Construct the implementation for a stored provider row.
pub fn build_provider(row: &AiProvider) -> Result<Box<dyn Provider>, String> {
    match row.kind.as_str() {
        "ollama" => Ok(Box::new(ollama::Ollama::new(&row.base_url))),
        other => Err(format!("unsupported AI provider kind: {other}")),
    }
}

/// In-flight runs, so a slow local generation can be stopped from the UI.
///
/// Managed Tauri state. Cancellation is a flag rather than a dropped future:
/// the streaming loop observes it between chunks and returns cleanly, which
/// lets the partial answer be saved.
#[derive(Default)]
pub struct AiState {
    next_run_id: AtomicU64,
    runs: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl AiState {
    /// Register a new run, returning its id and cancellation flag.
    pub fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next_run_id.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(id, flag.clone());
        }
        (id, flag)
    }

    /// Drop a finished run from the registry.
    pub fn end(&self, id: u64) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(&id);
        }
    }

    /// Signal a run to stop. Returns false if it had already finished.
    pub fn cancel(&self, id: u64) -> bool {
        match self.runs.lock() {
            Ok(runs) => match runs.get(&id) {
                Some(flag) => {
                    flag.store(true, Ordering::Relaxed);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }
}
