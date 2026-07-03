import { useEffect, useState } from "react";
import {
  meterMaster,
  renderMaster,
  type MasteringReport,
  type MediaFile,
} from "../../api";

interface Props {
  media: MediaFile;
  songId: number;
  /** Called with the newly rendered master so the list can refresh. */
  onRendered: (master: MediaFile) => void;
}

const TARGETS = [
  { value: -14, label: "−14 LUFS · Streaming" },
  { value: -16, label: "−16 LUFS · Dynamic" },
  { value: -9, label: "−9 LUFS · Loud" },
];

function db(v: number | null, digits = 1): string {
  return v == null ? "—" : `${v.toFixed(digits)} dB`;
}

/** Mastering controls for one media file: meter, recommend, render. */
export function MasteringSection({ media, songId, onRendered }: Props) {
  const [report, setReport] = useState<MasteringReport | null>(null);
  const [metering, setMetering] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState(-14);
  const [tonal, setTonal] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  // Auto-measure when the section opens.
  useEffect(() => {
    let cancelled = false;
    setMetering(true);
    setError(null);
    meterMaster(media.id)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setMetering(false));
    return () => {
      cancelled = true;
    };
  }, [media.id]);

  const render = async () => {
    setRendering(true);
    setError(null);
    setDone(null);
    try {
      const master = await renderMaster(media.id, songId, target, tonal);
      onRendered(master);
      setDone(`Mastered file created: ${master.name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setRendering(false);
    }
  };

  return (
    <div className="mastering">
      {metering && <p className="mastering-status">Measuring…</p>}
      {error && <p className="audio-error">{error}</p>}

      {report && (
        <>
          <div className="mastering-metrics">
            <Metric label="Loudness" value={db(report.input_lufs)} sub="LUFS-I" />
            <Metric label="True peak" value={db(report.true_peak_dbtp)} sub="dBTP" />
            <Metric label="Range" value={report.lra == null ? "—" : `${report.lra.toFixed(1)} LU`} sub="LRA" />
            <Metric label="Crest" value={db(report.crest_db)} sub="peak − RMS" />
          </div>

          <ul className="mastering-recs">
            {report.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>

          <div className="mastering-controls">
            <label className="mastering-target">
              Target
              <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                {TARGETS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mastering-tonal" title="Apply a gentle, capped tonal shelf">
              <input type="checkbox" checked={tonal} onChange={(e) => setTonal(e.target.checked)} />
              Tonal polish
            </label>
            <button onClick={render} disabled={rendering}>
              {rendering ? "Mastering…" : "Render master"}
            </button>
          </div>

          {done && <p className="mastering-done">{done}</p>}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="mastering-metric">
      <div className="mm-value">{value}</div>
      <div className="mm-label">{label}</div>
      <div className="mm-sub">{sub}</div>
    </div>
  );
}
