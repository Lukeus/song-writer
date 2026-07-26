import { useCallback, useEffect, useRef, useState } from "react";
import {
  aiCancelRun,
  aiCreateConversation,
  aiDefaultProvider,
  aiDeleteConversation,
  aiListConversations,
  aiListMessages,
  aiListModels,
  aiParseLyrics,
  aiProposedEdit,
  aiProviderHealth,
  aiSendMessage,
  aiSetConversationModel,
  aiSongContext,
  aiUpdateProvider,
  type AiConversation,
  type AiMessage,
  type AiModelInfo,
  type AiProvider,
  type ProposedEdit,
} from "../../api";
import type { UtilityContext } from "../types";

/** In-progress reply, held outside `messages` until the run is persisted. */
interface Streaming {
  runId: number | null;
  content: string;
  thinking: string;
}

/**
 * Pick a sensible default model: the one the provider last used, else the first
 * that can call tools (what the agent loop will need), else the first at all.
 */
function pickModel(models: AiModelInfo[], remembered: string | null): string | null {
  if (models.length === 0) return null;
  if (remembered && models.some((m) => m.name === remembered)) return remembered;
  const withTools = models.find((m) => m.capabilities.includes("tools"));
  return (withTools ?? models[0]).name;
}

/**
 * Does this reply carry chord notation the editor can anchor?
 *
 * Matches an uppercase root note with an optional accidental and a short
 * suffix — deliberately loose, since it only decides whether to *offer* the
 * chord actions. The authoritative check runs in Rust when parsing.
 */
const CHORD_MARKUP = /\[[A-G][#b♯♭]?[^\]\n]{0,10}\]\S/;

/** AI Agent utility: chat with a local model about the open song. */
export function AgentPanel({
  activeSongId,
  activeSong,
  insertBlocks,
  replaceBlocks,
}: UtilityContext) {
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [health, setHealth] = useState<string | null>(null);

  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);

  const [input, setInput] = useState("");
  const [think, setThink] = useState(false);
  const [showThinking, setShowThinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  /** Proposed song rewrites, keyed by the message that carried them. */
  const [edits, setEdits] = useState<Record<number, ProposedEdit>>({});
  const [autoApply, setAutoApply] = useState(
    () => localStorage.getItem("sw.ai.autoApply") === "1",
  );

  const songOpen = activeSong != null;
  const selected = models.find((m) => m.name === model) ?? null;
  const canThink = selected?.capabilities.includes("thinking") ?? false;
  const busy = streaming !== null;

  // Connect to the provider and load its models. The panel unmounts whenever
  // the user switches utility tabs, so this runs on every remount — cheap
  // against a local server, and it doubles as a liveness check.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await aiDefaultProvider();
        if (cancelled) return;
        setProvider(p);
        const [available, status] = await Promise.all([
          aiListModels(p.id),
          aiProviderHealth(p.id),
        ]);
        if (cancelled) return;
        setModels(available);
        setHealth(status);
        const chosen = pickModel(available, p.model);
        setModel(chosen);
        // Remember the choice so the next session opens on the same model.
        if (chosen && chosen !== p.model) {
          aiUpdateProvider(p.id, { model: chosen }).catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setHealth(null);
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the open song's threads, resuming the most recent one.
  useEffect(() => {
    if (activeSongId == null) {
      setConversations([]);
      setConversationId(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    aiListConversations(activeSongId)
      .then((rows) => {
        if (cancelled) return;
        setConversations(rows);
        setConversationId(rows[0]?.id ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [activeSongId]);

  // What the model will actually be shown. Re-fetched when the song's
  // `updated_at` moves, so it tracks the editor's autosave.
  useEffect(() => {
    if (activeSongId == null) {
      setContext(null);
      return;
    }
    let cancelled = false;
    aiSongContext(activeSongId)
      .then((c) => !cancelled && setContext(c))
      .catch(() => !cancelled && setContext(null));
    return () => {
      cancelled = true;
    };
  }, [activeSongId, activeSong?.updated_at]);

  useEffect(() => {
    localStorage.setItem("sw.ai.autoApply", autoApply ? "1" : "0");
  }, [autoApply]);

  /**
   * Load a thread's turns along with any song rewrites they propose. The two
   * are fetched together so a reply and its edit card always appear at once.
   */
  const loadThread = useCallback(async (id: number) => {
    const rows = await aiListMessages(id);
    const found: Record<number, ProposedEdit> = {};
    await Promise.all(
      rows
        .filter((m) => m.role === "assistant")
        .map(async (m) => {
          const edit = await aiProposedEdit(m.content).catch(() => null);
          if (edit) found[m.id] = edit;
        }),
    );
    return { rows, found };
  }, []);

  useEffect(() => {
    if (conversationId == null) {
      setMessages([]);
      setEdits({});
      return;
    }
    let cancelled = false;
    loadThread(conversationId)
      .then(({ rows, found }) => {
        if (cancelled) return;
        setMessages(rows);
        setEdits(found);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [conversationId, loadThread]);

  // Keep the newest text in view while tokens arrive.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streaming?.content]);

  const newChat = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
  };

  const removeChat = async (id: number) => {
    await aiDeleteConversation(id);
    const remaining = conversations.filter((c) => c.id !== id);
    setConversations(remaining);
    if (conversationId === id) setConversationId(remaining[0]?.id ?? null);
  };

  const changeModel = async (name: string) => {
    setModel(name);
    if (provider) aiUpdateProvider(provider.id, { model: name }).catch(() => {});
    // Existing threads keep generating with whatever is picked now.
    if (conversationId != null) {
      try {
        await aiSetConversationModel(conversationId, name);
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || model == null || activeSongId == null) return;
    setError(null);
    setInput("");

    let id = conversationId;
    try {
      if (id == null) {
        const convo = await aiCreateConversation(activeSongId, model, provider?.id ?? null);
        id = convo.id;
        setConversations((prev) => [convo, ...prev]);
        setConversationId(convo.id);
      }
    } catch (e) {
      setError(String(e));
      setInput(text);
      return;
    }

    // Show the user's turn immediately; the authoritative rows are reloaded
    // once the run ends. The negative id can't collide with a real rowid.
    const optimistic: AiMessage = {
      id: -Date.now(),
      conversation_id: id,
      role: "user",
      content: text,
      thinking: null,
      tool_calls_json: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setStreaming({ runId: null, content: "", thinking: "" });

    try {
      await aiSendMessage(id, text, canThink ? think : null, (event) => {
        switch (event.type) {
          case "started":
            setStreaming((s) => (s ? { ...s, runId: event.runId } : s));
            break;
          case "delta":
            setStreaming((s) => (s ? { ...s, content: s.content + event.text } : s));
            break;
          case "thinking":
            setStreaming((s) => (s ? { ...s, thinking: s.thinking + event.text } : s));
            break;
          case "error":
            setError(event.message);
            break;
          case "done":
            break;
        }
      });
      // Swap the live bubble for the persisted rows in one update, so the
      // finished reply never renders twice.
      const { rows, found } = await loadThread(id);
      setStreaming(null);
      setMessages(rows);
      setEdits(found);

      // Land the rewrite straight in the song when the user has asked for
      // that; otherwise it waits behind the Apply button on the edit card.
      if (autoApply) {
        const latest = [...rows].reverse().find((m) => found[m.id]);
        if (latest) replaceBlocks(found[latest.id].blocks);
      }
    } catch (e) {
      setError(String(e));
      // The user turn was persisted before the failure — reload so the
      // optimistic copy is replaced rather than duplicated on retry.
      const recovered = await loadThread(id).catch(() => null);
      setStreaming(null);
      if (recovered) {
        setMessages(recovered.rows);
        setEdits(recovered.found);
      }
    }
  }, [
    input,
    busy,
    model,
    activeSongId,
    conversationId,
    provider,
    canThink,
    think,
    autoApply,
    loadThread,
    replaceBlocks,
  ]);

  const stop = () => {
    if (streaming?.runId != null) aiCancelRun(streaming.runId).catch(() => {});
  };

  /** Append a reply to the song, turning any `[Bm]` markers into chord nodes. */
  const append = async (text: string) => {
    try {
      insertBlocks(await aiParseLyrics(text));
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * Put a proposed rewrite into the song, replacing what is there.
   *
   * Only the agent's fenced block is used, never its commentary. Not confirmed
   * with a dialog: the proposal is already shown in full above the button, and
   * ⌘Z in the editor undoes it.
   */
  const applyEdit = (edit: ProposedEdit) => replaceBlocks(edit.blocks);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <h2>AI Agent</h2>
        <div className="agent-header-actions">
          <select
            className="agent-model"
            value={model ?? ""}
            onChange={(e) => changeModel(e.target.value)}
            disabled={models.length === 0 || busy}
            title={provider ? `${provider.label} — ${provider.base_url}` : undefined}
          >
            {models.length === 0 && <option value="">no models</option>}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.parameter_size ? ` (${m.parameter_size})` : ""}
              </option>
            ))}
          </select>
          <button onClick={newChat} disabled={!songOpen} title="Start a new thread">
            New chat
          </button>
        </div>
      </div>

      <div className="agent-status">
        <span className={health ? "agent-dot online" : "agent-dot offline"} />
        {health ?? "not connected"}
        {context && (
          <button
            className="agent-context-toggle"
            onClick={() => setShowContext(!showContext)}
            title="Show exactly what the agent is given about this song"
          >
            {showContext ? "hide context" : "sees this song"}
          </button>
        )}
      </div>

      {showContext && context && <pre className="agent-context">{context}</pre>}

      {conversations.length > 1 && (
        <div className="agent-threads">
          {conversations.map((c) => (
            <span
              key={c.id}
              className={c.id === conversationId ? "agent-thread active" : "agent-thread"}
              onClick={() => setConversationId(c.id)}
              title={c.title}
            >
              {c.title}
              <button
                className="agent-thread-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  removeChat(c.id);
                }}
                title="Delete thread"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="agent-error">{error}</p>}

      {!songOpen ? (
        <p className="agent-empty">Open a song first to work with the agent.</p>
      ) : (
        <>
          <div className="agent-messages">
            {messages.length === 0 && !streaming && (
              <p className="agent-empty">
                Ask for a next line, a rhyme, a rewrite, or chord ideas.
              </p>
            )}

            {messages.map((m) => (
              <div key={m.id} className={`agent-msg agent-msg-${m.role}`}>
                {m.thinking && (
                  <button
                    className="agent-thinking-toggle"
                    onClick={() => setShowThinking(showThinking === m.id ? null : m.id)}
                  >
                    {showThinking === m.id ? "Hide reasoning" : "Reasoning"}
                  </button>
                )}
                {showThinking === m.id && m.thinking && (
                  <pre className="agent-thinking">{m.thinking}</pre>
                )}
                <div className="agent-msg-text">
                  {edits[m.id] ? edits[m.id].prose : m.content}
                </div>

                {edits[m.id] && (
                  <div className="agent-edit">
                    <div className="agent-edit-header">
                      Proposed song — {edits[m.id].blocks.length} lines
                    </div>
                    <pre className="agent-edit-body">{edits[m.id].lyrics}</pre>
                    <div className="agent-edit-actions">
                      <button
                        className="primary"
                        onClick={() => applyEdit(edits[m.id])}
                        title="Replace the song's lyrics with this version"
                      >
                        Apply to song
                      </button>
                      <button
                        onClick={() => insertBlocks(edits[m.id].blocks)}
                        title="Add this to the end of the song instead of replacing it"
                      >
                        Append instead
                      </button>
                    </div>
                  </div>
                )}

                {m.role === "assistant" && m.content && !edits[m.id] && (
                  <div className="agent-msg-actions">
                    <button
                      onClick={() => navigator.clipboard.writeText(m.content)}
                      title="Copy to clipboard"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => append(m.content)}
                      title="Append to the song, placing any chords above their syllables"
                    >
                      {CHORD_MARKUP.test(m.content) ? "Append with chords" : "Append to song"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {streaming && (
              <div className="agent-msg agent-msg-assistant">
                {streaming.thinking && (
                  <pre className="agent-thinking">{streaming.thinking}</pre>
                )}
                <div className="agent-msg-text">
                  {streaming.content || <span className="agent-caret">▍</span>}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="agent-composer">
            <textarea
              className="agent-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                model ? "Ask the agent…  (Enter to send, Shift+Enter for a new line)" : "No model available"
              }
              rows={3}
              disabled={!model}
            />
            <div className="agent-composer-actions">
              <label
                className="agent-think-toggle"
                title="Put proposed rewrites straight into the song instead of waiting for Apply. ⌘Z undoes."
              >
                <input
                  type="checkbox"
                  checked={autoApply}
                  onChange={(e) => setAutoApply(e.target.checked)}
                  disabled={busy}
                />
                Auto-apply
              </label>
              {canThink && (
                <label
                  className="agent-think-toggle"
                  title="Let the model reason before answering — slower, usually better structure"
                >
                  <input
                    type="checkbox"
                    checked={think}
                    onChange={(e) => setThink(e.target.checked)}
                    disabled={busy}
                  />
                  Reasoning
                </label>
              )}
              {busy ? (
                <button onClick={stop} disabled={streaming?.runId == null}>
                  Stop
                </button>
              ) : (
                <button onClick={send} disabled={!input.trim() || !model}>
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
