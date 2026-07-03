import { useMemo } from "react";
import type { Song } from "../api";

interface Props {
  songs: Song[];
}

/** Dedicated overview view summarising the song library. */
export const Dashboard = ({ songs }: Props) => {
  const total = songs.length;

  const avgTitleLen = useMemo(() => {
    if (songs.length === 0) return 0;
    return Math.round(
      songs.reduce((sum, s) => sum + s.title.length, 0) / songs.length,
    );
  }, [songs]);

  const lastUpdated = useMemo(() => {
    if (songs.length === 0) return "—";
    const latest = songs.reduce((a, b) =>
      a.updated_at > b.updated_at ? a : b,
    );
    const d = new Date(latest.updated_at);
    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
  }, [songs]);

  return (
    <div className="dashboard">
      <h2>Dashboard</h2>
      <div className="dashboard-stats">
        <div className="stat-card">
          <div className="stat-value">{total}</div>
          <div className="stat-label">Total songs</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{avgTitleLen}</div>
          <div className="stat-label">Avg title length (chars)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{lastUpdated}</div>
          <div className="stat-label">Last updated</div>
        </div>
      </div>
    </div>
  );
};
