import { useCallback, useEffect, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import { ChordEditor } from "./editor/ChordEditor";
import { UtilitiesPane } from "./components/UtilitiesPane";
import { Dashboard } from "./components/Dashboard";
import { PaneResizer, usePaneWidth } from "./components/PaneResizer";
import {
  createSong,
  deleteSong,
  listSongs,
  updateSong,
  type Song,
} from "./api";
import "./App.css";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** Default widths of the side panes, and how far they may be dragged. */
const SIDEBAR = { default: 248, min: 176, max: 460 };
const UTILITIES = { default: 312, min: 240, max: 620 };

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
  const [activeId, setActiveId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [doc, setDoc] = useState<JSONContent>(EMPTY_DOC);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<"songs" | "dashboard">("songs");
  const [sidebarWidth, setSidebarWidth] = usePaneWidth("sw.pane.sidebar", SIDEBAR.default);
  const [utilitiesWidth, setUtilitiesWidth] = usePaneWidth(
    "sw.pane.utilities",
    UTILITIES.default,
  );

  const active = songs.find((s) => s.id === activeId) ?? null;
  const saveTimer = useRef<number | null>(null);

  const selectSong = (song: Song) => {
    setActiveId(song.id);
    setTitle(song.title);
    setDoc(parseDoc(song.content_json));
  };

  // Initial load.
  useEffect(() => {
    listSongs().then((rows) => {
      setSongs(rows);
      if (rows.length > 0) selectSong(rows[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newSong = async () => {
    const created = await createSong("Untitled", JSON.stringify(EMPTY_DOC));
    setSongs((prev) => [created, ...prev]);
    selectSong(created);
  };

  const removeSong = async (id: number) => {
    await deleteSong(id);
    const remaining = songs.filter((s) => s.id !== id);
    setSongs(remaining);
    if (activeId === id) {
      if (remaining.length > 0) selectSong(remaining[0]);
      else {
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
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        setSaving(true);
        const updated = await updateSong(activeId, nextTitle, JSON.stringify(nextDoc));
        setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        setSaving(false);
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

  // Merge a song updated by a utility (e.g. Logic-project link) back into state.
  const onSongChanged = (updated: Song) =>
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  // Append blocks to the editor. If the doc is still empty (a single blank
  // paragraph), replace it rather than leaving a leading blank line. The
  // ChordEditor re-syncs on `doc` changes.
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

  // Swap the whole body — used when a utility rewrites the song (e.g. the
  // agent adding chords over existing lyrics). Callers confirm first.
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

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <button
          className={view === "songs" ? "nav-tab active" : "nav-tab"}
          onClick={() => setView("songs")}
        >
          Songs
        </button>
        <button
          className={view === "dashboard" ? "nav-tab active" : "nav-tab"}
          onClick={() => setView("dashboard")}
        >
          Dashboard
        </button>
      </nav>

      {view === "dashboard" ? (
        <Dashboard songs={songs} />
      ) : (
        <div
          className="app"
          style={{
            gridTemplateColumns: `${sidebarWidth}px auto minmax(0, 1fr) auto ${utilitiesWidth}px`,
          }}
        >
          <aside className="sidebar">
            <div className="sidebar-header">
              <h1>Songs</h1>
              <button onClick={newSong}>+ New</button>
            </div>
            <ul className="song-list">
              {songs.map((s) => (
                <li
                  key={s.id}
                  className={s.id === activeId ? "song-item active" : "song-item"}
                  onClick={() => selectSong(s)}
                >
                  <span className="song-title">{s.title || "Untitled"}</span>
                  <button
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
              ))}
              {songs.length === 0 && <li className="song-empty">No songs yet — create one.</li>}
            </ul>
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

          <main className="editor-pane">
            {active ? (
              <>
                <div className="editor-titlebar">
                  <input
                    className="title-input"
                    value={title}
                    onChange={(e) => onTitleChange(e.target.value)}
                    placeholder="Song title"
                  />
                  <span className="save-status">{saving ? "Saving…" : "Saved"}</span>
                </div>
                <ChordEditor content={doc} onChange={onDocChange} />
              </>
            ) : (
              <div className="editor-empty">Select or create a song to start writing.</div>
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
    </div>
  );
}
