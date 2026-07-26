//! Ollama provider — a local model server, no API key.
//!
//! Uses the `/api/chat` endpoint in streaming mode, which replies with
//! newline-delimited JSON: one frame per token, then a final frame with
//! `done: true`. Thinking-capable models put their reasoning in a separate
//! `thinking` field, which we keep out of the answer.

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;

use super::{ChatOutcome, ChatRequest, ModelInfo, Provider, StreamEvent};

/// How long to wait for the server to respond at all. Generation itself is
/// unbounded — a large model on CPU can take minutes to produce a first token,
/// so only the *connect* phase is capped.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Ollama {
    base_url: String,
    client: reqwest::Client,
}

impl Ollama {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .unwrap_or_default(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    /// Turn a transport error into something a songwriter can act on.
    fn explain(&self, e: reqwest::Error) -> String {
        if e.is_connect() || e.is_timeout() {
            format!(
                "Could not reach Ollama at {}. Start it with `ollama serve`.",
                self.base_url
            )
        } else {
            e.to_string()
        }
    }
}

/// `/api/tags` response.
#[derive(Debug, Deserialize)]
struct TagsResponse {
    models: Vec<TagModel>,
}

#[derive(Debug, Deserialize)]
struct TagModel {
    name: String,
    #[serde(default)]
    details: TagDetails,
    /// Absent on older Ollama builds; treated as "unknown", not "none".
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TagDetails {
    #[serde(default)]
    parameter_size: Option<String>,
}

/// One newline-delimited frame from `/api/chat`.
#[derive(Debug, Deserialize)]
struct ChatFrame {
    #[serde(default)]
    message: Option<FrameMessage>,
    #[serde(default)]
    done: bool,
    /// Ollama reports in-band failures (e.g. unknown model) this way.
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FrameMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: Option<String>,
}

#[async_trait::async_trait]
impl Provider for Ollama {
    async fn list_models(&self) -> Result<Vec<ModelInfo>, String> {
        let resp = self
            .client
            .get(self.url("/api/tags"))
            .send()
            .await
            .map_err(|e| self.explain(e))?;
        if !resp.status().is_success() {
            return Err(format!("Ollama returned {}", resp.status()));
        }
        let tags: TagsResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(tags
            .models
            .into_iter()
            .map(|m| ModelInfo {
                name: m.name,
                parameter_size: m.details.parameter_size,
                capabilities: m.capabilities,
            })
            .collect())
    }

    async fn health(&self) -> Result<String, String> {
        let models = self.list_models().await?;
        Ok(match models.len() {
            0 => "connected — no models installed (`ollama pull …`)".to_string(),
            1 => "connected — 1 model".to_string(),
            n => format!("connected — {n} models"),
        })
    }

    async fn chat_stream(
        &self,
        req: ChatRequest,
        sink: &Channel<StreamEvent>,
        cancel: Arc<AtomicBool>,
    ) -> Result<ChatOutcome, String> {
        let mut body = json!({
            "model": req.model,
            "messages": req.messages,
            "stream": true,
        });
        if let Some(temp) = req.temperature {
            body["options"] = json!({ "temperature": temp });
        }
        // Only sent for models that advertise `thinking`; see `ChatRequest`.
        if let Some(think) = req.think {
            body["think"] = json!(think);
        }

        let resp = self
            .client
            .post(self.url("/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|e| self.explain(e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(error_message(&body, status));
        }

        let mut stream = resp.bytes_stream();
        // Buffer bytes, not text: a chunk boundary can fall inside a multi-byte
        // character, so we only decode once a whole line is in hand.
        let mut buf: Vec<u8> = Vec::new();
        let mut content = String::new();
        let mut thinking = String::new();

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                return Ok(outcome(content, thinking, true));
            }
            let chunk = chunk.map_err(|e| format!("stream interrupted: {e}"))?;
            buf.extend_from_slice(&chunk);

            while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let frame: ChatFrame = match serde_json::from_str(line) {
                    Ok(f) => f,
                    // Skip anything unparseable rather than killing a run that
                    // is otherwise producing good tokens.
                    Err(_) => continue,
                };
                if let Some(err) = frame.error {
                    return Err(err);
                }
                if let Some(msg) = frame.message {
                    if let Some(t) = msg.thinking.filter(|t| !t.is_empty()) {
                        thinking.push_str(&t);
                        let _ = sink.send(StreamEvent::Thinking { text: t });
                    }
                    if !msg.content.is_empty() {
                        content.push_str(&msg.content);
                        let _ = sink.send(StreamEvent::Delta { text: msg.content });
                    }
                }
                if frame.done {
                    return Ok(outcome(content, thinking, false));
                }
            }
        }

        // Stream ended without a `done` frame — keep whatever arrived.
        Ok(outcome(content, thinking, false))
    }
}

/// Pull the useful sentence out of an Ollama failure.
///
/// Errors arrive as a non-2xx status with `{"error": "…"}` — that message is
/// already user-facing ("model 'x' not found"), so prefer it over the status
/// line and only fall back when the body is not the expected shape.
fn error_message(body: &str, status: reqwest::StatusCode) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| {
            let body = body.trim();
            if body.is_empty() {
                format!("Ollama returned {status}")
            } else {
                format!("Ollama returned {status}: {body}")
            }
        })
}

fn outcome(content: String, thinking: String, cancelled: bool) -> ChatOutcome {
    ChatOutcome {
        content,
        thinking: if thinking.is_empty() {
            None
        } else {
            Some(thinking)
        },
        cancelled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames captured verbatim from a live `ollama serve` (0.x, `/api/chat`).
    const DELTA: &str = r#"{"model":"llama3.2:latest","created_at":"2026-07-25T15:43:42.9Z","message":{"role":"assistant","content":"Hello"},"done":false}"#;
    const FINAL: &str = r#"{"model":"llama3.2:latest","created_at":"2026-07-25T15:43:42.9Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":2157022333,"eval_count":3}"#;
    const THINKING: &str = r#"{"model":"gpt-oss:20b","created_at":"2026-07-25T15:43:42.9Z","message":{"role":"assistant","content":"","thinking":"Let me count syllables."},"done":false}"#;

    #[test]
    fn parses_content_delta() {
        let f: ChatFrame = serde_json::from_str(DELTA).unwrap();
        assert!(!f.done);
        assert_eq!(f.message.unwrap().content, "Hello");
    }

    #[test]
    fn parses_final_frame_with_stats() {
        // The last frame carries timing fields we don't model; they must not
        // break deserialization.
        let f: ChatFrame = serde_json::from_str(FINAL).unwrap();
        assert!(f.done);
        assert!(f.error.is_none());
    }

    #[test]
    fn separates_thinking_from_content() {
        let msg = serde_json::from_str::<ChatFrame>(THINKING)
            .unwrap()
            .message
            .unwrap();
        assert_eq!(msg.content, "");
        assert_eq!(msg.thinking.as_deref(), Some("Let me count syllables."));
    }

    #[test]
    fn error_message_prefers_the_servers_sentence() {
        assert_eq!(
            error_message(
                r#"{"error":"model 'nope:404' not found"}"#,
                reqwest::StatusCode::NOT_FOUND
            ),
            "model 'nope:404' not found"
        );
    }

    #[test]
    fn error_message_falls_back_to_the_status() {
        assert_eq!(
            error_message("", reqwest::StatusCode::BAD_GATEWAY),
            "Ollama returned 502 Bad Gateway"
        );
    }

    #[test]
    fn base_url_trailing_slash_is_normalised() {
        let o = Ollama::new("http://127.0.0.1:11434/");
        assert_eq!(o.url("/api/chat"), "http://127.0.0.1:11434/api/chat");
    }
}
