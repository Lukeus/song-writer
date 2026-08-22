import { useEffect, useMemo, useState } from "react";
import {
  listLogicProjects,
  type LogicProject,
  type MediaFile,
  type Song,
} from "../api";
import { extractChordsFromDoc } from "../editor/chordShapes";
import { suggestChordsInKey } from "../editor/musicTheory";

interface Props {
  songs: Song[];
  songMediaMap?: Record<number, MediaFile[]>;
  onSelectSong: (song: Song) => void;
  activeSongId: number | null;
}

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w`;
}

interface SongSummary {
  song: Song;
  keyName: string;
  bpm: string;
  subtitle: string;
  hasLogic: boolean;
  relativeTime: string;
  isUntouched: boolean;
  hasNoKey: boolean;
  unAnalyzedDemos: number;
}

export const Dashboard = ({ songs, songMediaMap = {}, onSelectSong, activeSongId }: Props) => {
  const [logicProjects, setLogicProjects] = useState<LogicProject[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    listLogicProjects()
      .then(setLogicProjects)
      .catch(() => {});
  }, []);

  const songSummaries = useMemo<SongSummary[]>(() => {
    return songs.map((s) => {
      let chords: string[] = [];
      let lineCount = 0;
      let charCount = 0;

      if (s.content_json) {
        try {
          const doc = JSON.parse(s.content_json);
          chords = extractChordsFromDoc(doc);
          if (Array.isArray(doc.content)) {
            lineCount = doc.content.length;
            charCount = doc.content.reduce(
              (acc: number, node: any) =>
                acc +
                (node.content?.reduce(
                  (cAcc: number, cNode: any) => cAcc + (cNode.text?.length || 0),
                  0,
                ) || 0),
              0,
            );
          }
        } catch {
          // ignore
        }
      }

      const media = songMediaMap[s.id] || [];
      const analyzedMedia = media.filter((m) => m.analysis_status === "done");
      const unAnalyzedDemos = media.filter((m) => m.analysis_status === "pending" || m.analysis_status === "running").length;

      const latestAnalyzed = analyzedMedia.find((m) => m.musical_key || m.bpm != null);

      let keyName = latestAnalyzed?.musical_key || "—";
      let bpm = latestAnalyzed?.bpm != null ? `${latestAnalyzed.bpm}` : "—";

      if (keyName === "—" && chords.length > 0) {
        const suggestion = suggestChordsInKey(chords[0]);
        if (suggestion) {
          keyName = suggestion.keyName.replace(" major", "").replace(" minor", "m");
        } else {
          keyName = chords[0];
        }
      }

      let subtitle = "SKETCH";
      if (analyzedMedia.length > 0) {
        subtitle = `${chords.length > 0 ? "CHORUS DRAFTED · " : ""}${analyzedMedia.length} DEMO${analyzedMedia.length === 1 ? "" : "S"} ANALYZED`;
      } else if (lineCount > 10 && chords.length > 3) {
        subtitle = "FULL DRAFT · CHORDS ATTACHED";
      } else if (chords.length > 0) {
        subtitle = `DRAFT · ${chords.length} CHORDS`;
      } else if (charCount > 0) {
        subtitle = `LYRICS ONLY · ${lineCount} LINES`;
      } else {
        subtitle = "EMPTY DRAFT";
      }

      const diffDays = (Date.now() - new Date(s.updated_at).getTime()) / (1000 * 3600 * 24);
      const isUntouched = diffDays >= 7;
      const hasNoKey = keyName === "—";

      return {
        song: s,
        keyName,
        bpm,
        subtitle,
        hasLogic: s.logic_project_id != null,
        relativeTime: formatRelativeTime(s.updated_at),
        isUntouched,
        hasNoKey,
        unAnalyzedDemos,
      };
    });
  }, [songs, songMediaMap]);

  const totalLinked = useMemo(
    () => songs.filter((s) => s.logic_project_id != null).length,
    [songs],
  );

  const thisWeekCount = useMemo(() => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return songs.filter((s) => new Date(s.updated_at).getTime() >= oneWeekAgo).length;
  }, [songs]);

  const attentionItems = useMemo(() => {
    const items: { text: string; strongText: string; song: Song }[] = [];
    songSummaries.forEach((sum) => {
      if (sum.hasNoKey && items.length < 3) {
        items.push({
          strongText: sum.song.title || "Untitled",
          text: "has no key or chords — suggestions are off",
          song: sum.song,
        });
      } else if (sum.unAnalyzedDemos > 0 && items.length < 3) {
        items.push({
          strongText: `${sum.unAnalyzedDemos} demo${sum.unAnalyzedDemos === 1 ? "" : "s"} in ${sum.song.title || "Untitled"}`,
          text: "imported but never analyzed",
          song: sum.song,
        });
      } else if (sum.isUntouched && items.length < 3) {
        items.push({
          strongText: sum.song.title || "Untitled",
          text: `untouched for ${sum.relativeTime}`,
          song: sum.song,
        });
      }
    });
    return items;
  }, [songSummaries]);

  const rescanLogic = async () => {
    setScanning(true);
    try {
      const projs = await listLogicProjects();
      setLogicProjects(projs);
    } catch {
      // ignore
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="dashboard-container">
      <div className="dashboard-card">
        {/* Header */}
        <div className="dashboard-head">
          <div className="dashboard-title">the lab</div>
          <div className="dashboard-meta-badge">
            {songs.length} SONGS · {totalLinked} LINKED · {thisWeekCount} THIS WEEK
          </div>
        </div>
        <div className="dashboard-tagline">
          pick up where you left off — not perfect. wanting to be.
        </div>

        {/* Main Grid */}
        <div className="dashboard-grid">
          {/* Recently Worked column */}
          <div className="dashboard-recent-col">
            <div className="dashboard-col-title">RECENTLY WORKED</div>
            <div className="dashboard-songs-list">
              {songSummaries.length > 0 ? (
                songSummaries.map((sum) => {
                  const isSelected = sum.song.id === activeSongId;
                  return (
                    <div
                      key={sum.song.id}
                      className={
                        isSelected
                          ? "dashboard-song-row active"
                          : "dashboard-song-row"
                      }
                      onClick={() => onSelectSong(sum.song)}
                    >
                      <div className="dashboard-song-info">
                        <div className="dashboard-song-title">
                          {sum.song.title || "Untitled"}
                        </div>
                        <div className="dashboard-song-sub">{sum.subtitle}</div>
                      </div>

                      <span className="dashboard-song-key">
                        {sum.keyName} {sum.bpm !== "—" ? `· ${sum.bpm}` : ""}
                      </span>

                      <span
                        className={
                          sum.hasLogic
                            ? "dashboard-logic-icon linked"
                            : "dashboard-logic-icon"
                        }
                        title={sum.hasLogic ? "Linked to Logic Pro" : "Not linked"}
                      >
                        ◈
                      </span>

                      <span className="dashboard-song-time">
                        {sum.relativeTime}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="dashboard-empty-note">
                  No songs in library yet. Create your first song to get started.
                </div>
              )}
            </div>
          </div>

          {/* Right column: Attention & Catalog */}
          <div className="dashboard-side-col">
            {/* Needs Attention */}
            <div className="dashboard-panel-card">
              <div className="dashboard-card-title">NEEDS ATTENTION</div>
              <div className="dashboard-attention-list">
                {attentionItems.length > 0 ? (
                  attentionItems.map((item, idx) => (
                    <div
                      key={idx}
                      className="dashboard-attention-item"
                      onClick={() => onSelectSong(item.song)}
                    >
                      <b>{item.strongText}</b> {item.text}
                    </div>
                  ))
                ) : (
                  <div className="dashboard-attention-all-good">
                    All songs in your library are actively maintained and in key.
                  </div>
                )}
              </div>
            </div>

            {/* Logic Pro Catalog */}
            <div className="dashboard-panel-card">
              <div className="dashboard-catalog-head">
                <span className="dashboard-card-title">LOGIC PRO CATALOG</span>
                <button
                  type="button"
                  className="dashboard-rescan-btn"
                  onClick={rescanLogic}
                  disabled={scanning}
                >
                  {scanning ? "SCANNING…" : "RESCAN"}
                </button>
              </div>
              <div className="dashboard-catalog-body">
                {logicProjects.length} projects found · {totalLinked} linked
                <br />
                <span className="dashboard-catalog-time">
                  last scan · {logicProjects[0]?.last_scanned_at ? formatRelativeTime(logicProjects[0].last_scanned_at) : "today"}
                </span>
              </div>
            </div>

            {/* Setlists */}
            <div className="dashboard-setlists-card">
              SETLISTS · coming soon
              <br />
              <span className="dashboard-setlists-sub">
                group songs for a show or a release
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
