import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { ChordEditor } from "./editor/ChordEditor";
import { UtilitiesPane } from "./components/UtilitiesPane";
import { Dashboard } from "./components/Dashboard";
import { PaneResizer, usePaneWidth } from "./components/PaneResizer";
import { GlobalAudioBar } from "./components/GlobalAudioBar";
import { AudioStudioModal } from "./components/AudioStudioModal";
import { extractChordsFromDoc } from "./editor/chordShapes";
import { suggestChordsInKey } from "./editor/musicTheory";
import {
  createSong,
  deleteSong,
  listLogicProjects,
  listSongMedia,
  listSongs,
  updateSong,
  type LogicProject,
  type MediaFile,
  type Song,
} from "./api";
import "./App.css";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** Default widths of the side panes, and how far they may be dragged. */
const SIDEBAR = { default: 248, min: 176, max: 460 };
const UTILITIES = { default: 340, min: 240, max: 620 };

function parseDoc(json: string): JSONContent {
  if (!json) return EMPTY_DOC;
  try {
    return JSON.parse(json) as JSONContent;
  } catch {
    return EMPTY_DOC;
  }
}

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [songMediaMap, setSongMediaMap] = useState<Record<number, MediaFile[]>>({});
  const [activeId, setActiveId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [doc, setDoc] = useState<JSONContent>(EMPTY_DOC);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"songs" | "dashboard">("songs");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "in_progress" | "linked">("all");
  const [logicProjects, setLogicProjects] = useState<LogicProject[]>([]);
  const [sidebarWidth, setSidebarWidth] = usePaneWidth("sw.pane.sidebar", SIDEBAR.default);
  const [utilitiesWidth, setUtilitiesWidth] = usePaneWidth(
    "sw.pane.utilities",
    UTILITIES.default,
  );
  const [isStudioOpen, setIsStudioOpen] = useState(false);

  const active = songs.find((s) => s.id === activeId) ?? null;
  const saveTimer = useRef<number | null>(null);
  const pendingSaveRef = useRef<{ songId: number; title: string; doc: JSONContent } | null>(null);

  const flushPendingSave = useCallback(async () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingSaveRef.current) {
      const { songId, title: sTitle, doc: sDoc } = pendingSaveRef.current;
      pendingSaveRef.current = null;
      setSaving(true);
      try {
        const updated = await updateSong(songId, sTitle, JSON.stringify(sDoc));
        setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      } catch {
        // preserve state if save failed
      } finally {
        setSaving(false);
      }
    }
  }, []);

  const selectSong = async (song: Song) => {
    if (activeId === song.id) return;
    await flushPendingSave();
    setActiveId(song.id);
    setTitle(song.title);
    setDoc(parseDoc(song.content_json));
  };

  const loadMediaForSongs = useCallback((songList: Song[]) => {
    songList.forEach((s) => {
      listSongMedia(s.id)
        .then((files) => {
          setSongMediaMap((prev) => ({ ...prev, [s.id]: files }));
        })
        .catch(() => {});
    });
  }, []);

  // Initial load.
  useEffect(() => {
    listSongs().then((rows) => {
      setSongs(rows);
      if (rows.length > 0) {
        setActiveId(rows[0].id);
        setTitle(rows[0].title);
        setDoc(parseDoc(rows[0].content_json));
      }
      loadMediaForSongs(rows);
    });
    listLogicProjects().then(setLogicProjects).catch(() => {});
  }, [loadMediaForSongs]);

  const newSong = async () => {
    await flushPendingSave();
    const created = await createSong("Untitled", JSON.stringify(EMPTY_DOC));
    setSongs((prev) => [created, ...prev]);
    setActiveId(created.id);
    setTitle(created.title);
    setDoc(EMPTY_DOC);
    if (view === "dashboard") setView("songs");
  };

  const removeSong = async (id: number) => {
    if (pendingSaveRef.current?.songId === id) {
      pendingSaveRef.current = null;
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await deleteSong(id);
    const remaining = songs.filter((s) => s.id !== id);
    setSongs(remaining);
    if (activeId === id) {
      if (remaining.length > 0) {
        setActiveId(remaining[0].id);
        setTitle(remaining[0].title);
        setDoc(parseDoc(remaining[0].content_json));
      } else {
        setActiveId(null);
        setTitle("");
        setDoc(EMPTY_DOC);
      }
    }
  };

  // Debounced autosave whenever title or doc changes for the active song.
  const scheduleSave = useCallback(
    (nextTitle: string, nextDoc: JSONContent) => {
      if (activeId == null) return;
      pendingSaveRef.current = { songId: activeId, title: nextTitle, doc: nextDoc };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        if (!pendingSaveRef.current) return;
        const currentToSave = pendingSaveRef.current;
        pendingSaveRef.current = null;
        setSaving(true);
        try {
          const updated = await updateSong(
            currentToSave.songId,
            currentToSave.title,
            JSON.stringify(currentToSave.doc),
          );
          setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        } finally {
          setSaving(false);
        }
      }, 600);
    },
    [activeId],
  );

  const onTitleChange = (v: string) => {
    setTitle(v);
    scheduleSave(v, doc);
  };

  const onDocChange = (d: JSONContent) => {
    setDoc(d);
    scheduleSave(title, d);
  };

  const refreshMediaForSong = (songId: number) => {
    listSongMedia(songId)
      .then((files) => {
        setSongMediaMap((prev) => ({ ...prev, [songId]: files }));
      })
      .catch(() => {});
  };

  // Merge a song updated by a utility back into state.
  const onSongChanged = (updated: Song) => {
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    refreshMediaForSong(updated.id);
  };

  // Append blocks to the editor.
  const insertBlocks = (blocks: JSONContent[]) => {
    if (activeId == null || blocks.length === 0) return;
    const prevContent = Array.isArray(doc.content) ? doc.content : [];
    const docIsEmpty =
      prevContent.length === 0 ||
      (prevContent.length === 1 && !prevContent[0].content);
    const next: JSONContent = {
      type: "doc",
      content: [...(docIsEmpty ? [] : prevContent), ...blocks],
    };
    setDoc(next);
    scheduleSave(title, next);
  };

  // Swap the whole body.
  const replaceBlocks = (blocks: JSONContent[]) => {
    if (activeId == null || blocks.length === 0) return;
    const next: JSONContent = { type: "doc", content: blocks };
    setDoc(next);
    scheduleSave(title, next);
  };

  // Append plain transcribed lyrics: one paragraph per line.
  const insertLyrics = (text: string) => {
    if (!text.trim()) return;
    insertBlocks(
      text.split("\n").map((line) =>
        line.trim()
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
    );
  };

  const linkedCount = useMemo(
    () => songs.filter((s) => s.logic_project_id != null).length,
    [songs],
  );

  const filteredSongs = useMemo(() => {
    return songs.filter((s) => {
      if (filter === "linked" && s.logic_project_id == null) return false;
      if (filter === "in_progress") {
        let hasContent = false;
        if (s.content_json) {
          try {
            const parsed = JSON.parse(s.content_json);
            hasContent =
              (parsed.content?.length > 0 &&
                parsed.content[0].content?.length > 0) ||
              extractChordsFromDoc(parsed).length > 0;
          } catch {
            // ignore
          }
        }
        if (!hasContent) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const titleMatch = s.title.toLowerCase().includes(q);
        const contentMatch = s.content_json.toLowerCase().includes(q);
        if (!titleMatch && !contentMatch) return false;
      }
      return true;
    });
  }, [songs, filter, searchQuery]);

  // Helper to extract key & metadata from song doc or media files
  const getSongMeta = (song: Song) => {
    const media = songMediaMap[song.id] || [];
    const analyzed = media.find(
      (m) => m.analysis_status === "done" && (m.bpm != null || m.musical_key != null),
    );

    let key = analyzed?.musical_key || "—";
    let bpm = analyzed?.bpm != null ? `${analyzed.bpm} BPM` : "—";

    if (key === "—" && song.content_json) {
      try {
        const parsed = JSON.parse(song.content_json);
        const chords = extractChordsFromDoc(parsed);
        if (chords.length > 0) {
          const sugg = suggestChordsInKey(chords[0]);
          key = sugg
            ? sugg.keyName.replace(" major", "").replace(" minor", "m")
            : chords[0];
        }
      } catch {
        // ignore
      }
    }

    return {
      key,
      bpm,
      hasLogic: song.logic_project_id != null,
    };
  };

  return (
    <div className="app-shell">
      {/* Top Header Navigation */}
      <nav className="app-nav">
        <div className="app-nav-brand">[ song writer ]</div>
        <div className="app-nav-tabs">
          <button
            type="button"
            className={view === "songs" ? "nav-tab active" : "nav-tab"}
            onClick={() => setView("songs")}
          >
            SONGS
          </button>
          <button
            type="button"
            className={view === "dashboard" ? "nav-tab active" : "nav-tab"}
            onClick={() => setView("dashboard")}
          >
            DASHBOARD
          </button>
        </div>
        <div className="app-nav-save-status">
          {saving ? "saving…" : "saved · just now"}
        </div>
      </nav>

      {/* Main View */}
      {view === "dashboard" ? (
        <Dashboard
          songs={songs}
          songMediaMap={songMediaMap}
          activeSongId={activeId}
          onSelectSong={(s) => {
            selectSong(s);
            setView("songs");
          }}
        />
      ) : (
        <div
          className="app"
          style={{
            gridTemplateColumns: `${sidebarWidth}px auto minmax(0, 1fr) auto ${utilitiesWidth}px`,
          }}
        >
          {/* Left Sidebar */}
          <aside className="sidebar">
            <div className="sidebar-header">
              <div className="sidebar-search-row">
                <input
                  type="text"
                  className="sidebar-search-input"
                  placeholder="search songs…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button
                  type="button"
                  onClick={newSong}
                  className="new-song-btn"
                  title="Create new song"
                >
                  + new
                </button>
              </div>
              <div className="sidebar-filters">
                <button
                  type="button"
                  className={filter === "all" ? "sidebar-chip active" : "sidebar-chip"}
                  onClick={() => setFilter("all")}
                >
                  ALL
                </button>
                <button
                  type="button"
                  className={filter === "in_progress" ? "sidebar-chip active" : "sidebar-chip"}
                  onClick={() => setFilter("in_progress")}
                >
                  IN PROGRESS
                </button>
                <button
                  type="button"
                  className={filter === "linked" ? "sidebar-chip active" : "sidebar-chip"}
                  onClick={() => setFilter("linked")}
                >
                  LINKED
                </button>
              </div>
            </div>

            <ul className="song-list">
              {filteredSongs.map((s) => {
                const meta = getSongMeta(s);
                const isActive = s.id === activeId;
                return (
                  <li
                    key={s.id}
                    className={isActive ? "song-item active" : "song-item"}
                    onClick={() => selectSong(s)}
                  >
                    <div className="song-item-body">
                      <div className="song-title">{s.title || "Untitled"}</div>
                      <div className="song-meta-line">
                        <span>
                          {meta.key} · {meta.bpm}
                        </span>
                        {meta.hasLogic && (
                          <span className="song-logic-tag">◈ LOGIC</span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="song-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSong(s.id);
                      }}
                      title="Delete song"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
              {filteredSongs.length === 0 && (
                <li className="song-empty">
                  {songs.length === 0
                    ? "No songs yet — create one."
                    : "No matching songs found."}
                </li>
              )}
            </ul>

            <div className="sidebar-footer">
              {songs.length} {songs.length === 1 ? "song" : "songs"} · {linkedCount} linked to logic
            </div>
          </aside>

          <PaneResizer
            width={sidebarWidth}
            onChange={setSidebarWidth}
            side="left"
            min={SIDEBAR.min}
            max={SIDEBAR.max}
            defaultWidth={SIDEBAR.default}
            label="Resize song list"
          />

          {/* Central Editor Pane */}
          <main className="editor-pane">
            {active ? (
              <>
                <div className="editor-titlebar">
                  <div className="editor-title-row">
                    <input
                      className="title-input"
                      value={title}
                      onChange={(e) => onTitleChange(e.target.value)}
                      placeholder="Song title"
                    />
                    <span className="save-status">
                      {saving ? "Saving…" : "Saved"}
                    </span>
                  </div>
                  {(() => {
                    const activeMeta = getSongMeta(active);
                    const activeLogicProject =
                      active.logic_project_id != null
                        ? logicProjects.find(
                            (p) => p.id === active.logic_project_id,
                          )
                        : null;
                    return (
                      <div className="editor-meta-badges">
                        <span
                          className={`editor-meta-badge ${
                            activeMeta.key !== "—" ? "key" : ""
                          }`}
                        >
                          KEY ·{" "}
                          {activeMeta.key !== "—"
                            ? activeMeta.key.toUpperCase()
                            : "NOT SET"}
                        </span>
                        <span className="editor-meta-badge">
                          {activeMeta.bpm !== "—"
                            ? `${activeMeta.bpm} BPM`
                            : "— BPM"}
                        </span>
                        {activeLogicProject ? (
                          <span
                            className="editor-meta-badge logic"
                            title={activeLogicProject.path}
                          >
                            ◈ {activeLogicProject.name}
                          </span>
                        ) : activeMeta.hasLogic ? (
                          <span className="editor-meta-badge logic">
                            ◈ LOGIC LINKED
                          </span>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
                <ChordEditor content={doc} onChange={onDocChange} />
              </>
            ) : (
              <div className="editor-empty-wrapper">
                <div className="editor-empty">
                  Select or create a song to start writing.
                </div>
                <div className="editor-empty-statusbar" />
              </div>
            )}
          </main>

          <PaneResizer
            width={utilitiesWidth}
            onChange={setUtilitiesWidth}
            side="right"
            min={UTILITIES.min}
            max={UTILITIES.max}
            defaultWidth={UTILITIES.default}
            label="Resize utilities pane"
          />

          {/* Right Utilities Pane */}
          <aside className="projects-pane">
            <UtilitiesPane
              ctx={{
                activeSongId: activeId,
                activeSong: active,
                onSongChanged,
                insertLyrics,
                insertBlocks,
                replaceBlocks,
              }}
            />
          </aside>
        </div>
      )}

      {/* Global Audio Transport Bar (Persists across tabs/views) */}
      <GlobalAudioBar onOpenStudio={() => setIsStudioOpen(true)} />

      {/* Full Parametric EQ & A/B Comparison Studio Modal */}
      {isStudioOpen && (
        <AudioStudioModal
          isOpen={isStudioOpen}
          onClose={() => setIsStudioOpen(false)}
          songId={activeId ?? undefined}
          availableMedia={activeId ? (songMediaMap[activeId] ?? []) : []}
          onMasterRendered={(_master) => {
            if (activeId) {
              refreshMediaForSong(activeId);
            }
          }}
        />
      )}
    </div>
  );
}
