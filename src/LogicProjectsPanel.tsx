import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  addGlobalBounceFolder,
  cancelWaveformSearch,
  deleteGlobalBounceFolder,
  exportSongMidi,
  findMatchingLogicProjects,
  getLogicProjectDetails,
  importAudioFile,
  listGlobalBounceFolders,
  listLogicProjects,
  listProjectBounces,
  openLogicProject,
  scanLogicProjects,
  type AudioMatchResult,
  type BounceFolder,
  type LogicProject,
  type LogicProjectDetails,
  type ProjectBounce,
} from "./api";

interface Props {
  /** id of the Logic project currently linked to the open song, if any. */
  linkedProjectId: number | null;
  /** Active song ID if a song is open. */
  activeSongId?: number | null;
  /** Called when the user links/unlinks a project to the current song. */
  onLink: (projectId: number | null) => void;
  /** Whether a song is open (link buttons are disabled otherwise). */
  songOpen: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Catalog of `.logicx` projects: scan, browse, link, auto-match waveform, open in Logic, and 1-click import bounces. */
export function LogicProjectsPanel({ linkedProjectId, activeSongId, onLink, songOpen }: Props) {
  const [projects, setProjects] = useState<LogicProject[]>([]);
  const [scanning, setScanning] = useState(false);
  const [matchingWaveform, setMatchingWaveform] = useState(false);
  const [matchResults, setMatchResults] = useState<AudioMatchResult[] | null>(null);
  const [exportingMidi, setExportingMidi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [bouncesMap, setBouncesMap] = useState<Record<number, ProjectBounce[] | "loading">>({});
  const [detailsMap, setDetailsMap] = useState<Record<number, LogicProjectDetails | "loading">>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({});
  const [importingPath, setImportingPath] = useState<string | null>(null);

  // Global Bounce Folders state
  const [globalFolders, setGlobalFolders] = useState<BounceFolder[]>([]);
  const [showGlobalFolders, setShowGlobalFolders] = useState(false);

  useEffect(() => {
    listLogicProjects()
      .then((projs) => {
        setProjects(projs);
        // Automatically expand bounces & details for linked project if present
        if (linkedProjectId) {
          setExpandedProjects((prev) => ({ ...prev, [linkedProjectId]: true }));
          const linked = projs.find((p) => p.id === linkedProjectId);
          if (linked) {
            loadProjectData(linked.id, linked.path);
          }
        }
      })
      .catch((e) => setError(String(e)));

    listGlobalBounceFolders()
      .then(setGlobalFolders)
      .catch(() => {});
  }, [linkedProjectId]);

  const handleAddGlobalFolder = async () => {
    setError(null);
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Select Global Bounces / Exports Folder",
    });
    if (!dir || typeof dir !== "string") return;
    try {
      const added = await addGlobalBounceFolder(dir);
      setGlobalFolders((prev) => {
        if (prev.some((f) => f.id === added.id || f.path === added.path)) return prev;
        return [...prev, added];
      });
      setStatusMsg(`Added global bounces folder: "${added.path}"`);
      setTimeout(() => setStatusMsg(null), 4000);
    } catch (e) {
      setError(`Failed to add global bounce folder: ${e}`);
    }
  };

  const handleDeleteGlobalFolder = async (id: number) => {
    try {
      await deleteGlobalBounceFolder(id);
      setGlobalFolders((prev) => prev.filter((f) => f.id !== id));
      setStatusMsg("Removed global bounces folder");
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (e) {
      setError(`Failed to remove global bounce folder: ${e}`);
    }
  };

  const loadProjectData = async (projectId: number, projectPath: string) => {
    setBouncesMap((prev) => ({ ...prev, [projectId]: "loading" }));
    setDetailsMap((prev) => ({ ...prev, [projectId]: "loading" }));

    try {
      const [bounces, details] = await Promise.all([
        listProjectBounces(projectPath),
        getLogicProjectDetails(projectPath).catch(() => null),
      ]);
      setBouncesMap((prev) => ({ ...prev, [projectId]: bounces }));
      if (details) {
        setDetailsMap((prev) => ({ ...prev, [projectId]: details }));
      }
    } catch (e) {
      setError(`Failed to inspect project: ${e}`);
      setBouncesMap((prev) => ({ ...prev, [projectId]: [] }));
    }
  };

  const toggleExpanded = (p: LogicProject) => {
    const isExpanded = !expandedProjects[p.id];
    setExpandedProjects((prev) => ({ ...prev, [p.id]: isExpanded }));
    if (isExpanded && (!bouncesMap[p.id] || bouncesMap[p.id] === "loading")) {
      loadProjectData(p.id, p.path);
    }
  };

  const handleAutoMatch = async () => {
    if (activeSongId == null) {
      setError("Open a song with attached audio to perform waveform search.");
      return;
    }
    setError(null);
    setMatchingWaveform(true);
    try {
      const results = await findMatchingLogicProjects(activeSongId);
      setMatchResults(results);
      if (results.length === 0) {
        setStatusMsg("No waveform matches found in cataloged Logic projects.");
      } else {
        setStatusMsg(`Found ${results.length} matching Logic project candidate(s)!`);
      }
      setTimeout(() => setStatusMsg(null), 5000);
    } catch (e) {
      setError(`Waveform search failed: ${e}`);
    } finally {
      setMatchingWaveform(false);
    }
  };

  const handleCancelMatch = async () => {
    try {
      await cancelWaveformSearch();
    } catch {
      // ignore
    }
    setMatchingWaveform(false);
    setStatusMsg("Waveform search cancelled.");
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const handleOpenInLogic = async (path: string, name: string) => {
    setError(null);
    try {
      await openLogicProject(path);
      setStatusMsg(`Opened "${name}" in Logic Pro`);
      setTimeout(() => setStatusMsg(null), 4000);
    } catch (e) {
      setError(`Could not launch Logic Pro: ${e}`);
    }
  };

  const handleExportMidi = async (project?: LogicProject) => {
    if (activeSongId == null) {
      setError("Open a song first to export its MIDI progression.");
      return;
    }
    setError(null);
    try {
      const defaultFilename = project ? `${project.name}_chords.mid` : "song_chords.mid";
      const filePath = await save({
        title: "Export MIDI for Logic Pro",
        defaultPath: defaultFilename,
        filters: [{ name: "MIDI File", extensions: ["mid"] }],
      });
      if (!filePath) return;

      setExportingMidi(true);
      const savedPath = await exportSongMidi(activeSongId, filePath);
      setStatusMsg(`MIDI exported: ${savedPath}`);
      setTimeout(() => setStatusMsg(null), 5000);
    } catch (e) {
      setError(`Failed to export MIDI: ${e}`);
    } finally {
      setExportingMidi(false);
    }
  };

  const handleImportBounce = async (bounce: ProjectBounce) => {
    if (activeSongId == null) {
      setError("Open a song first before importing a bounce.");
      return;
    }
    setError(null);
    setImportingPath(bounce.path);
    try {
      await importAudioFile(activeSongId, bounce.path);
      setStatusMsg(`Imported "${bounce.name}" to active song`);
      setTimeout(() => setStatusMsg(null), 4000);
    } catch (e) {
      setError(`Failed to import bounce: ${e}`);
    } finally {
      setImportingPath(null);
    }
  };

  const handleLinkAndImport = async (m: AudioMatchResult) => {
    if (activeSongId == null) {
      setError("Open a song first.");
      return;
    }
    setError(null);
    setImportingPath(m.matched_bounce_path);
    try {
      onLink(m.logic_project_id);
      await importAudioFile(activeSongId, m.matched_bounce_path);
      setStatusMsg(`Linked "${m.logic_project_name}" and imported "${m.matched_bounce_name}"!`);
      setTimeout(() => setStatusMsg(null), 5000);
    } catch (e) {
      setError(`Failed to link & import: ${e}`);
    } finally {
      setImportingPath(null);
    }
  };

  const chooseAndScan = async () => {
    setError(null);
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder to scan for Logic projects" });
    if (!dir || typeof dir !== "string") return;
    setScanning(true);
    try {
      const found = await scanLogicProjects(dir);
      setProjects(found);
      setStatusMsg(`Scanned ${found.length} project(s)`);
      setTimeout(() => setStatusMsg(null), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="logic-panel">
      <div className="logic-panel-header">
        <h2>LOGIC PROJECTS</h2>
        <div className="logic-panel-header-actions">
          {matchingWaveform ? (
            <button
              className="logic-header-btn cancel"
              onClick={handleCancelMatch}
              title="Stop in-flight waveform search"
            >
              cancel
            </button>
          ) : (
            <button
              className="logic-header-btn match"
              disabled={!songOpen}
              onClick={handleAutoMatch}
              title={songOpen ? "Search catalog by audio waveform to find matching Logic project" : "Open a song first"}
            >
              auto-match
            </button>
          )}
          <button
            className="logic-header-btn midi"
            disabled={!songOpen || exportingMidi}
            onClick={() => handleExportMidi()}
            title={songOpen ? "Export chords & section markers to Standard MIDI for Logic" : "Open a song first"}
          >
            {exportingMidi ? "exporting…" : "export midi"}
          </button>
          <button
            className={showGlobalFolders ? "logic-header-btn active" : "logic-header-btn"}
            onClick={() => setShowGlobalFolders((v) => !v)}
            title="Configure Global Bounces & Export directories"
          >
            global bounces {globalFolders.length > 0 ? `(${globalFolders.length})` : ""}
          </button>
          <button onClick={chooseAndScan} disabled={scanning || matchingWaveform}>
            {scanning ? "scanning…" : "scan folder…"}
          </button>
        </div>
      </div>

      {error && <p className="logic-error">{error}</p>}
      {statusMsg && <p className="logic-status">{statusMsg}</p>}

      {/* Global Bounce Folders Management Drawer */}
      {showGlobalFolders && (
        <div className="logic-global-folders-box">
          <div className="logic-gf-header">
            <div>
              <span className="logic-gf-title">GLOBAL BOUNCE DIRECTORIES</span>
              <p className="logic-gf-desc">
                Bounced audio files in these locations will be automatically matched to your songs & Logic projects.
              </p>
            </div>
            <button className="logic-gf-add-btn" onClick={handleAddGlobalFolder}>
              + add folder…
            </button>
          </div>

          <div className="logic-gf-defaults-note">
            Standard locations (e.g. <code>~/Music/Logic/Bounces</code>) are automatically scanned.
          </div>

          {globalFolders.length === 0 ? (
            <p className="logic-gf-empty">No custom global bounce folders configured yet.</p>
          ) : (
            <ul className="logic-gf-list">
              {globalFolders.map((f) => (
                <li key={f.id} className="logic-gf-item">
                  <span className="logic-gf-path" title={f.path}>{f.path}</span>
                  <button
                    className="logic-gf-delete-btn"
                    onClick={() => handleDeleteGlobalFolder(f.id)}
                    title="Remove folder from global bounce search"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Waveform Match Results Banner */}
      {matchResults && matchResults.length > 0 && (
        <div className="logic-match-results">
          <div className="logic-match-header">
            <span className="logic-match-title">WAVEFORM MATCHES ({matchResults.length})</span>
            <button className="logic-match-close" onClick={() => setMatchResults(null)}>dismiss</button>
          </div>
          <ul className="logic-match-list">
            {matchResults.map((m) => {
              const isLinked = m.logic_project_id === linkedProjectId;
              const badgeClass =
                m.confidence_pct >= 85
                  ? "logic-match-badge high"
                  : m.confidence_pct >= 65
                  ? "logic-match-badge mid"
                  : "logic-match-badge";

              return (
                <li key={`${m.logic_project_id}-${m.matched_bounce_path}`} className="logic-match-item">
                  <div className="logic-match-info">
                    <div className="logic-match-title-row">
                      <span className="logic-match-name">{m.logic_project_name}</span>
                      <span className={badgeClass}>{m.confidence_pct.toFixed(0)}% Match</span>
                    </div>
                    <span className="logic-match-meta">
                      Matched file: <code>{m.matched_bounce_name}</code>
                    </span>
                    <span className="logic-match-reason">{m.match_reason}</span>
                    <div className="logic-match-player-wrap">
                      <MatchAuditionPlayer path={m.matched_bounce_path} name={m.matched_bounce_name} />
                    </div>
                  </div>
                  <div className="logic-match-actions">
                    <button
                      className="logic-action-btn primary"
                      onClick={() => handleOpenInLogic(m.logic_project_path, m.logic_project_name)}
                      title="Open project in Logic Pro"
                    >
                      open
                    </button>
                    <button
                      className="logic-action-btn import-link"
                      disabled={!songOpen || importingPath === m.matched_bounce_path}
                      onClick={() => handleLinkAndImport(m)}
                      title="Link this Logic project and import its bounce to the song"
                    >
                      {importingPath === m.matched_bounce_path ? "importing…" : "link & import"}
                    </button>
                    <button
                      className={isLinked ? "logic-action-btn unlink" : "logic-action-btn link"}
                      disabled={!songOpen}
                      onClick={() => onLink(isLinked ? null : m.logic_project_id)}
                      title={isLinked ? "Unlink from song" : "Link project to song"}
                    >
                      {isLinked ? "unlink" : "link only"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {projects.length === 0 && !error && (
        <p className="logic-empty">No projects yet. Scan a folder containing <code>.logicx</code> files.</p>
      )}

      <ul className="logic-list">
        {projects.map((p) => {
          const linked = p.id === linkedProjectId;
          const isExpanded = !!expandedProjects[p.id];
          const projectBounces = bouncesMap[p.id];
          const details = detailsMap[p.id];

          return (
            <li key={p.id} className={linked ? "logic-item linked" : "logic-item"}>
              <div className="logic-item-main">
                <div className="logic-item-title-row">
                  <span className="logic-name">{p.name}</span>
                  {linked && <span className="logic-linked-badge">Linked to song</span>}
                </div>
                <span className="logic-meta">
                  created {formatDate(p.created_at)} · modified {formatDate(p.modified_at)}
                </span>
                <span className="logic-path" title={p.path}>{p.path}</span>

                {typeof details === "object" && details !== null && (
                  <div className="logic-details-summary">
                    {details.alternatives.length > 1 && (
                      <span className="logic-detail-pill">
                        {details.alternatives.length} Alternatives
                      </span>
                    )}
                    {details.audio_files_count > 0 && (
                      <span className="logic-detail-pill">
                        {details.audio_files_count} Audio Tracks
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="logic-item-actions">
                <button
                  className="logic-action-btn primary"
                  onClick={() => handleOpenInLogic(p.path, p.name)}
                  title="Open project directly in Logic Pro"
                >
                  open in logic
                </button>
                <button
                  className="logic-action-btn"
                  onClick={() => revealItemInDir(p.path)}
                  title="Reveal in Finder"
                >
                  reveal
                </button>
                <button
                  className="logic-action-btn"
                  onClick={() => toggleExpanded(p)}
                  title="View project details, alternatives & discovered bounces"
                >
                  {isExpanded ? "hide details" : "details & bounces…"}
                </button>
                <button
                  className={linked ? "logic-action-btn unlink" : "logic-action-btn link"}
                  disabled={!songOpen}
                  onClick={() => onLink(linked ? null : p.id)}
                  title={songOpen ? "" : "Open a song first"}
                >
                  {linked ? "unlink" : "link to song"}
                </button>
              </div>

              {isExpanded && (
                <div className="logic-bounces-section">
                  {typeof details === "object" && details !== null && details.alternatives.length > 0 && (
                    <div className="logic-alts-block">
                      <span className="logic-bounces-title">PROJECT ALTERNATIVES</span>
                      <div className="logic-alts-list">
                        {details.alternatives.map((alt) => (
                          <div key={alt.id} className="logic-alt-pill" title={`Alternative folder: ${alt.id}`}>
                            <span className="logic-alt-name">{alt.name}</span>
                            {alt.modified_at && (
                              <span className="logic-alt-time">({formatDate(alt.modified_at)})</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="logic-bounces-header">
                    <span className="logic-bounces-title">DISCOVERED BOUNCES & AUDIO</span>
                    <button
                      className="logic-bounces-refresh"
                      onClick={() => loadProjectData(p.id, p.path)}
                      disabled={projectBounces === "loading"}
                    >
                      {projectBounces === "loading" ? "scanning…" : "refresh"}
                    </button>
                  </div>

                  {projectBounces === "loading" && (
                    <p className="logic-bounces-empty">Searching project folder for audio bounces…</p>
                  )}

                  {Array.isArray(projectBounces) && projectBounces.length === 0 && (
                    <p className="logic-bounces-empty">
                      No bounces found yet in <code>Bounces/</code> or <code>Audio Files/</code>.
                    </p>
                  )}

                  {Array.isArray(projectBounces) && projectBounces.length > 0 && (
                    <ul className="logic-bounces-list">
                      {projectBounces.map((b) => (
                        <li key={b.path} className="logic-bounce-item">
                          <div className="logic-bounce-info">
                            <div className="logic-bounce-name-row">
                              <span className="logic-bounce-name" title={b.path}>{b.name}</span>
                              {b.origin === "global" && (
                                <span className="logic-bounce-global-badge" title="Discovered in Global Bounces folder">
                                  GLOBAL
                                </span>
                              )}
                            </div>
                            <span className="logic-bounce-meta">
                              {b.format.toUpperCase()} · {formatBytes(b.size_bytes)} · {formatDate(b.modified_at)}
                            </span>
                          </div>
                          <button
                            className="logic-bounce-import-btn"
                            disabled={!songOpen || importingPath === b.path}
                            onClick={() => handleImportBounce(b)}
                            title={songOpen ? "Import into current song for analysis & playback" : "Open a song first"}
                          >
                            {importingPath === b.path ? "importing…" : "+ import to song"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MatchAuditionPlayer({ path, name }: { path: string; name: string }) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const src = convertFileSrc(path);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => setError(true));
    } else {
      el.pause();
    }
  };

  const progress = duration > 0 ? (current / duration) * 100 : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrent(el.currentTime);
  };

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="logic-audition-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.duration) setDuration(e.currentTarget.duration);
        }}
        onError={() => setError(true)}
      />
      <button
        type="button"
        className={"logic-audition-play" + (playing ? " playing" : "")}
        onClick={toggle}
        disabled={error}
        title={playing ? "Pause" : `Preview ${name}`}
      >
        {playing ? "❚❚" : "▸"}
      </button>
      <div className="logic-audition-bar" onClick={seek} title="Click to seek">
        <div className="logic-audition-fill" style={{ width: `${progress}%` }} />
      </div>
      <span className="logic-audition-time">
        {error ? "err" : `${fmt(current)} / ${fmt(duration)}`}
      </span>
    </div>
  );
}

