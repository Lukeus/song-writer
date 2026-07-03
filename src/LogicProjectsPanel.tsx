import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listLogicProjects, scanLogicProjects, type LogicProject } from "./api";

interface Props {
  /** id of the Logic project currently linked to the open song, if any. */
  linkedProjectId: number | null;
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

/** Catalog of `.logicx` projects: scan a folder, browse, link, reveal in Finder. */
export function LogicProjectsPanel({ linkedProjectId, onLink, songOpen }: Props) {
  const [projects, setProjects] = useState<LogicProject[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLogicProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const chooseAndScan = async () => {
    setError(null);
    const dir = await open({ directory: true, multiple: false, title: "Choose a folder to scan for Logic projects" });
    if (!dir || typeof dir !== "string") return;
    setScanning(true);
    try {
      setProjects(await scanLogicProjects(dir));
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="logic-panel">
      <div className="logic-panel-header">
        <h2>Logic Projects</h2>
        <button onClick={chooseAndScan} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan folder…"}
        </button>
      </div>

      {error && <p className="logic-error">{error}</p>}

      {projects.length === 0 && !error && (
        <p className="logic-empty">No projects yet. Scan a folder containing <code>.logicx</code> files.</p>
      )}

      <ul className="logic-list">
        {projects.map((p) => {
          const linked = p.id === linkedProjectId;
          return (
            <li key={p.id} className={linked ? "logic-item linked" : "logic-item"}>
              <div className="logic-item-main">
                <span className="logic-name">{p.name}</span>
                <span className="logic-meta">
                  created {formatDate(p.created_at)} · modified {formatDate(p.modified_at)}
                </span>
                <span className="logic-path" title={p.path}>{p.path}</span>
              </div>
              <div className="logic-item-actions">
                <button onClick={() => revealItemInDir(p.path)} title="Reveal in Finder">Reveal</button>
                <button
                  disabled={!songOpen}
                  onClick={() => onLink(linked ? null : p.id)}
                  title={songOpen ? "" : "Open a song first"}
                >
                  {linked ? "Unlink" : "Link to song"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
