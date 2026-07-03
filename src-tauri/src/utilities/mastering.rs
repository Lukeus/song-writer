//! Mastering utility — measure a track's loudness/tonal profile and render a
//! mastered copy, all via the system `ffmpeg` binary.
//!
//! Metering uses ffmpeg's `loudnorm` (EBU R128 measurement) and `astats`.
//! Rendering uses a two-pass `loudnorm` to a target integrated loudness with
//! true-peak limiting, plus an optional gentle tonal shelf. The mastered file is
//! written to the app-data `masters/` folder and registered as a new media file
//! associated to the song — the original is never touched.

use crate::db::{self, Db, MediaFile};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

/// Loudness target presets are passed from the UI; this is the streaming default.
const DEFAULT_TARGET_LUFS: f64 = -14.0;
/// Ceiling for true-peak limiting (dBTP) — safe for lossy codecs.
const TRUE_PEAK_CEILING: f64 = -1.0;

#[derive(Debug, Clone, Serialize)]
pub struct MasteringReport {
    /// Integrated loudness of the input (LUFS).
    pub input_lufs: Option<f64>,
    /// Input true peak (dBTP).
    pub true_peak_dbtp: Option<f64>,
    /// Loudness range (LU).
    pub lra: Option<f64>,
    pub rms_db: Option<f64>,
    pub peak_db: Option<f64>,
    /// Crest factor in dB (peak − RMS): a rough dynamics indicator.
    pub crest_db: Option<f64>,
    /// RMS of the low band (<250 Hz) and high band (>4 kHz), dB.
    pub low_band_db: Option<f64>,
    pub high_band_db: Option<f64>,
    /// Plain-language findings and what a master would do.
    pub recommendations: Vec<String>,
}

/// Measured `loudnorm` input values needed for an accurate second pass.
struct LoudnormMeasured {
    input_i: f64,
    input_tp: f64,
    input_lra: f64,
    input_thresh: f64,
    target_offset: f64,
}

// ---- Commands ------------------------------------------------------------

/// Measure a media file and return a mastering report with recommendations.
#[tauri::command]
pub async fn meter_master(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
) -> Result<MasteringReport, String> {
    let path = media_path(&db, media_file_id)?;
    if !Path::new(&path).is_file() {
        return Err(format!("file not found: {path}"));
    }
    ensure_ffmpeg(&app).await?;

    let loud = parse_loudnorm(&run_loudnorm_measure(&app, &path).await?);
    let (rms_db, peak_db) = parse_overall_levels(&run_astats(&app, &path, None).await?);
    let low_band_db = parse_overall_rms(&run_astats(&app, &path, Some("lowpass=f=250")).await?);
    let high_band_db = parse_overall_rms(&run_astats(&app, &path, Some("highpass=f=4000")).await?);

    let crest_db = match (peak_db, rms_db) {
        (Some(p), Some(r)) => Some(p - r),
        _ => None,
    };

    let report = MasteringReport {
        input_lufs: loud.as_ref().map(|l| l.input_i),
        true_peak_dbtp: loud.as_ref().map(|l| l.input_tp),
        lra: loud.as_ref().map(|l| l.input_lra),
        rms_db,
        peak_db,
        crest_db,
        low_band_db,
        high_band_db,
        recommendations: build_recommendations(
            DEFAULT_TARGET_LUFS,
            loud.as_ref().map(|l| l.input_i),
            loud.as_ref().map(|l| l.input_tp),
            crest_db,
            low_band_db,
            high_band_db,
        ),
    };
    Ok(report)
}

/// Render a mastered copy at `target_lufs` and associate it with `song_id`.
#[tauri::command]
pub async fn render_master(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
    song_id: i64,
    target_lufs: f64,
    tonal_correction: bool,
) -> Result<MediaFile, String> {
    let src = media_path(&db, media_file_id)?;
    if !Path::new(&src).is_file() {
        return Err(format!("file not found: {src}"));
    }
    ensure_ffmpeg(&app).await?;

    // Pass 1: measure for an accurate, linear normalization in pass 2.
    let measured = parse_loudnorm(&run_loudnorm_measure(&app, &src).await?)
        .ok_or("could not measure loudness (ffmpeg loudnorm produced no data)")?;

    // Optional gentle tonal shelf, derived from the low/high band balance.
    let eq = if tonal_correction {
        let low = parse_overall_rms(&run_astats(&app, &src, Some("lowpass=f=250")).await?);
        let high = parse_overall_rms(&run_astats(&app, &src, Some("highpass=f=4000")).await?);
        tonal_eq_filter(low, high)
    } else {
        None
    };

    let out_path = master_output_path(&app, &src)?;
    run_loudnorm_render(&app, &src, &out_path, target_lufs, &measured, eq.as_deref()).await?;

    // Register the rendered file and link it to the song (reference in place).
    let name = Path::new(&out_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("master.wav")
        .to_string();
    let size = std::fs::metadata(&out_path).ok().map(|m| m.len() as i64);

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let media = db::import_media_file(&conn, &out_path, &name, Some("wav"), size)?;
    db::associate_media(&conn, song_id, media.id)?;
    Ok(media)
}

// ---- ffmpeg invocation ---------------------------------------------------

fn media_path(db: &State<'_, Db>, media_file_id: i64) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(db::get_media_file(&conn, media_file_id)?.path)
}

/// Confirm ffmpeg is callable, with a clear message if not.
async fn ensure_ffmpeg(app: &AppHandle) -> Result<(), String> {
    app.shell()
        .command("ffmpeg")
        .args(["-hide_banner", "-version"])
        .output()
        .await
        .map(|_| ())
        .map_err(|e| format!("ffmpeg is required for mastering but could not be run: {e}. Install ffmpeg and try again."))
}

/// Run ffmpeg and return combined stderr (where the filters log their stats).
async fn run_ffmpeg_stderr(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let out = app
        .shell()
        .command("ffmpeg")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed to run: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stderr).into_owned())
}

/// loudnorm measurement pass (prints JSON of measured input values to stderr).
async fn run_loudnorm_measure(app: &AppHandle, path: &str) -> Result<String, String> {
    run_ffmpeg_stderr(
        app,
        vec![
            "-hide_banner".into(),
            "-i".into(),
            path.into(),
            "-af".into(),
            format!(
                "loudnorm=I={DEFAULT_TARGET_LUFS}:TP={TRUE_PEAK_CEILING}:LRA=11:print_format=json"
            ),
            "-f".into(),
            "null".into(),
            "-".into(),
        ],
    )
    .await
}

/// astats pass, optionally preceded by a band filter (e.g. "lowpass=f=250").
async fn run_astats(app: &AppHandle, path: &str, pre_filter: Option<&str>) -> Result<String, String> {
    let af = match pre_filter {
        Some(f) => format!("{f},astats=measure_perchannel=none"),
        None => "astats=measure_perchannel=none".into(),
    };
    run_ffmpeg_stderr(
        app,
        vec![
            "-hide_banner".into(),
            "-i".into(),
            path.into(),
            "-af".into(),
            af,
            "-f".into(),
            "null".into(),
            "-".into(),
        ],
    )
    .await
}

/// Two-pass loudnorm render to `out_path`.
async fn run_loudnorm_render(
    app: &AppHandle,
    src: &str,
    out_path: &str,
    target_lufs: f64,
    m: &LoudnormMeasured,
    eq: Option<&str>,
) -> Result<(), String> {
    let loudnorm = format!(
        "loudnorm=I={target_lufs}:TP={TRUE_PEAK_CEILING}:LRA=11:\
measured_I={mi}:measured_TP={mtp}:measured_LRA={mlra}:measured_thresh={mth}:\
offset={off}:linear=true:print_format=summary",
        mi = m.input_i,
        mtp = m.input_tp,
        mlra = m.input_lra,
        mth = m.input_thresh,
        off = m.target_offset,
    );
    // EQ before loudnorm so the final loudness/peak still hit the target.
    let af = match eq {
        Some(eq) => format!("{eq},{loudnorm}"),
        None => loudnorm,
    };

    let out = app
        .shell()
        .command("ffmpeg")
        .args([
            "-hide_banner",
            "-y",
            "-i",
            src,
            "-af",
            &af,
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            out_path,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg render failed to run: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ffmpeg render failed (exit {:?}): {}",
            out.status.code(),
            stderr.lines().last().unwrap_or("").trim()
        ));
    }
    Ok(())
}

/// `<app-data>/masters/<stem>.master.wav`.
fn master_output_path(app: &AppHandle, src: &str) -> Result<String, String> {
    let dir: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("masters");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = Path::new(src)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track");
    Ok(dir.join(format!("{stem}.master.wav")).to_string_lossy().into_owned())
}

// ---- Parsing & analysis --------------------------------------------------

/// Extract the single flat JSON block loudnorm prints, and read its fields.
fn parse_loudnorm(stderr: &str) -> Option<LoudnormMeasured> {
    let start = stderr.rfind('{')?;
    let end = stderr.rfind('}')?;
    if end <= start {
        return None;
    }
    let json = &stderr[start..=end];
    let field = |key: &str| -> Option<f64> {
        let needle = format!("\"{key}\"");
        let i = json.find(&needle)?;
        let colon = json[i..].find(':')? + i;
        let rest = json[colon + 1..].trim_start();
        let val = rest.trim_start_matches('"');
        let valend = val.find(['"', ',', '\n', '}']).unwrap_or(val.len());
        val[..valend].trim().parse::<f64>().ok()
    };
    Some(LoudnormMeasured {
        input_i: field("input_i")?,
        input_tp: field("input_tp")?,
        input_lra: field("input_lra")?,
        input_thresh: field("input_thresh")?,
        target_offset: field("target_offset").unwrap_or(0.0),
    })
}

/// Last value for an astats label like "RMS level dB:" (Overall is printed last).
fn last_astats_value(stderr: &str, label: &str) -> Option<f64> {
    let needle = format!("{label}:");
    stderr
        .lines()
        .filter_map(|line| {
            let i = line.find(&needle)?;
            line[i + needle.len()..].trim().parse::<f64>().ok()
        })
        .last()
}

fn parse_overall_levels(stderr: &str) -> (Option<f64>, Option<f64>) {
    (
        last_astats_value(stderr, "RMS level dB"),
        last_astats_value(stderr, "Peak level dB"),
    )
}

fn parse_overall_rms(stderr: &str) -> Option<f64> {
    last_astats_value(stderr, "RMS level dB")
}

/// A gentle, capped tonal shelf based on the low/high band balance, or none.
fn tonal_eq_filter(low: Option<f64>, high: Option<f64>) -> Option<String> {
    let (low, high) = (low?, high?);
    let tilt = low - high; // typically positive (more low-end energy)
    // Nominal balanced tilt ~ +12 dB; nudge gently toward it, capped at ±2.5 dB.
    let deviation = tilt - 12.0;
    if deviation.abs() < 4.0 {
        return None; // already balanced enough; don't touch it
    }
    let gain = (deviation / 4.0).clamp(-1.0, 1.0) * 2.5;
    if deviation > 0.0 {
        // Bass-heavy / dull: trim lows, lift highs slightly.
        Some(format!("bass=g={:.1}:f=110,treble=g={:.1}:f=8000", -gain, gain * 0.8))
    } else {
        // Thin / harsh: add lows, ease highs slightly.
        Some(format!("bass=g={:.1}:f=110,treble=g={:.1}:f=8000", gain.abs(), -gain.abs() * 0.6))
    }
}

fn build_recommendations(
    target: f64,
    input_lufs: Option<f64>,
    true_peak: Option<f64>,
    crest_db: Option<f64>,
    low: Option<f64>,
    high: Option<f64>,
) -> Vec<String> {
    let mut recs = Vec::new();

    if let Some(lufs) = input_lufs {
        let gap = target - lufs;
        if gap > 0.5 {
            recs.push(format!(
                "Quieter than the {target:.0} LUFS target by {gap:.1} dB — mastering will raise it to match streaming loudness."
            ));
        } else if gap < -0.5 {
            recs.push(format!(
                "Louder than the {target:.0} LUFS target by {:.1} dB — mastering will pull it down for a cleaner, less fatiguing level.",
                -gap
            ));
        } else {
            recs.push("Loudness is already close to the target.".into());
        }
    }

    if let Some(tp) = true_peak {
        if tp > TRUE_PEAK_CEILING {
            recs.push(format!(
                "True peak is {tp:.1} dBTP (above {TRUE_PEAK_CEILING:.0} dBTP) — limiting will prevent inter-sample clipping on lossy formats."
            ));
        }
    }

    if let Some(crest) = crest_db {
        if crest < 6.0 {
            recs.push(format!(
                "Low dynamic range ({crest:.1} dB crest) — the track is already heavily compressed; mastering will avoid squashing it further."
            ));
        } else if crest > 16.0 {
            recs.push(format!(
                "Very dynamic ({crest:.1} dB crest) — loudness matching will apply gentle limiting to even it out."
            ));
        }
    }

    if let (Some(low), Some(high)) = (low, high) {
        let tilt = low - high;
        if tilt > 18.0 {
            recs.push("Tonal balance leans bass-heavy/dull — a gentle high-shelf lift can add air.".into());
        } else if tilt < 6.0 {
            recs.push("Tonal balance leans bright/thin — a gentle low-shelf can add warmth and body.".into());
        }
    }

    if recs.is_empty() {
        recs.push("No major issues detected — mastering will apply loudness normalization and true-peak safety.".into());
    }
    recs
}
