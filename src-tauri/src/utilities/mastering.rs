//! Mastering utility — measure a track's loudness/tonal profile and render a
//! mastered copy with professional DSP processing, all via the system `ffmpeg` binary.
//!
//! DSP chain includes:
//! 1. Infrasonic sub-rumble cleanup (28 Hz linear-phase high-pass)
//! 2. Parametric de-mudding notch (280 Hz) & silky air sheen (11 kHz)
//! 3. Adaptive tonal-balance shelf
//! 4. Analog tape warmth / gentle soft-knee glue compression
//! 5. Stereo soundstage width enhancement
//! 6. Two-pass EBU R128 linear loudness normalization & true-peak limiter
//! 7. 24-bit HD Broadcast WAV output (`pcm_s24le`)

use crate::db::{self, Db, MediaFile};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

/// Default target integrated loudness (LUFS-I) for streaming platforms.
const DEFAULT_TARGET_LUFS: f64 = -14.0;
/// True-peak ceiling in dBTP — protects against inter-sample peaks on lossy codecs.
const TRUE_PEAK_CEILING: f64 = -1.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EqBandParam {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub band_type: String,
    pub frequency: f64,
    pub gain: f64,
    pub q: f64,
    pub enabled: bool,
}

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
    /// Crest factor in dB (peak − RMS): dynamics indicator.
    pub crest_db: Option<f64>,
    /// RMS of low band (<250 Hz) and high band (>4 kHz), dB.
    pub low_band_db: Option<f64>,
    pub high_band_db: Option<f64>,
    /// Plain-language findings and mastering recommendations.
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

/// Render a mastered 24-bit copy at `target_lufs` with character processing options.
#[tauri::command]
pub async fn render_master(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
    song_id: i64,
    target_lufs: f64,
    tonal_correction: bool,
    profile: Option<String>,
    tape_warmth: Option<bool>,
    stereo_enhance: Option<bool>,
    clarity_air: Option<bool>,
) -> Result<MediaFile, String> {
    let src = media_path(&db, media_file_id)?;
    if !Path::new(&src).is_file() {
        return Err(format!("file not found: {src}"));
    }
    ensure_ffmpeg(&app).await?;

    // Determine effective target and character based on profile or explicit flags
    let (eff_target, eff_warmth, eff_stereo, eff_air, eff_tonal) = match profile.as_deref() {
        Some("warm") => (-14.0, true, true, true, true),
        Some("modern") => (-11.0, true, true, true, true),
        Some("loud") => (-9.0, true, false, true, false),
        Some("dynamic") => (-16.0, false, true, true, false),
        _ => (
            target_lufs,
            tape_warmth.unwrap_or(false),
            stereo_enhance.unwrap_or(false),
            clarity_air.unwrap_or(true),
            tonal_correction,
        ),
    };

    // Pass 1: measure for linear loudness normalization
    let measured = parse_loudnorm(&run_loudnorm_measure(&app, &src).await?)
        .ok_or("could not measure loudness (ffmpeg loudnorm produced no data)")?;

    // Pre-processing filter chain: Infrasonic cleanup, EQ, Tape warmth, Stereo width
    let mut pre_filters: Vec<String> = Vec::new();

    // 1. Infrasonic sub-rumble cleanup (removes inaudible <28Hz mud)
    pre_filters.push("highpass=f=28:p=2".to_string());

    // 2. Parametric de-mud notch (gentle cut at 280 Hz to clear boxiness)
    if eff_tonal {
        pre_filters.push("equalizer=f=280:g=-1.0:w=1.2:t=q".to_string());
    }

    // 3. Adaptive tonal balance shelf
    if eff_tonal {
        let low = parse_overall_rms(&run_astats(&app, &src, Some("lowpass=f=250")).await?);
        let high = parse_overall_rms(&run_astats(&app, &src, Some("highpass=f=4000")).await?);
        if let Some(eq) = tonal_eq_filter(low, high) {
            pre_filters.push(eq);
        }
    }

    // 4. Silky air sheen (gentle high-shelf boost at 11 kHz for modern acoustic polish)
    if eff_air {
        pre_filters.push("highshelf=f=11000:g=1.4:w=0.71:t=q".to_string());
    }

    // 5. Analog tape warmth (soft-knee glue compressor)
    if eff_warmth {
        pre_filters.push("acompressor=threshold=-14dB:ratio=1.4:attack=25:release=140:makeup=1.0:knee=4dB".to_string());
    }

    // 6. Stereo soundstage width enhancement (subtle 8% side expansion)
    if eff_stereo {
        pre_filters.push("stereotools=mlev=1.0:slev=1.08".to_string());
    }

    let pre_filter_str = if pre_filters.is_empty() {
        None
    } else {
        Some(pre_filters.join(","))
    };

    let out_path = master_output_path(&app, &src, profile.as_deref())?;
    run_loudnorm_render(&app, &src, &out_path, eff_target, &measured, pre_filter_str.as_deref()).await?;

    // Register the rendered 24-bit file and link it to the song
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

/// Render a mastered 24-bit copy applying an active parametric EQ filter curve,
/// analog warmth/stereo character, and EBU R128 loudness normalization.
#[tauri::command]
pub async fn render_master_with_eq(
    app: AppHandle,
    db: State<'_, Db>,
    media_file_id: i64,
    song_id: i64,
    target_lufs: f64,
    eq_bands: Vec<EqBandParam>,
    tape_warmth: Option<bool>,
    stereo_enhance: Option<bool>,
) -> Result<MediaFile, String> {
    let src = media_path(&db, media_file_id)?;
    if !Path::new(&src).is_file() {
        return Err(format!("file not found: {src}"));
    }
    ensure_ffmpeg(&app).await?;

    let measured = parse_loudnorm(&run_loudnorm_measure(&app, &src).await?)
        .ok_or("could not measure loudness (ffmpeg loudnorm produced no data)")?;

    let mut pre_filters: Vec<String> = Vec::new();

    // 1. Build Parametric EQ filters from eq_bands
    for band in &eq_bands {
        if !band.enabled {
            continue;
        }
        let freq = band.frequency.clamp(20.0, 20000.0);
        let gain = band.gain.clamp(-24.0, 24.0);
        let q = band.q.clamp(0.1, 20.0);

        match band.band_type.as_str() {
            "highpass" => {
                pre_filters.push(format!("highpass=f={:.1}:p=2", freq));
            }
            "lowpass" => {
                pre_filters.push(format!("lowpass=f={:.1}:p=2", freq));
            }
            "lowshelf" => {
                if gain.abs() > 0.05 {
                    pre_filters.push(format!("lowshelf=f={:.1}:g={:.2}:w={:.2}:t=q", freq, gain, q));
                }
            }
            "highshelf" => {
                if gain.abs() > 0.05 {
                    pre_filters.push(format!("highshelf=f={:.1}:g={:.2}:w={:.2}:t=q", freq, gain, q));
                }
            }
            "peaking" => {
                if gain.abs() > 0.05 {
                    pre_filters.push(format!("equalizer=f={:.1}:g={:.2}:w={:.2}:t=q", freq, gain, q));
                }
            }
            _ => {}
        }
    }

    // 2. Analog tape warmth (soft-knee glue compressor)
    if tape_warmth.unwrap_or(false) {
        pre_filters.push("acompressor=threshold=-14dB:ratio=1.4:attack=25:release=140:makeup=1.0:knee=4dB".to_string());
    }

    // 3. Stereo soundstage width enhancement (subtle 8% side expansion)
    if stereo_enhance.unwrap_or(false) {
        pre_filters.push("stereotools=mlev=1.0:slev=1.08".to_string());
    }

    let pre_filter_str = if pre_filters.is_empty() {
        None
    } else {
        Some(pre_filters.join(","))
    };

    let out_path = master_output_path(&app, &src, Some("eq-master"))?;
    run_loudnorm_render(&app, &src, &out_path, target_lufs, &measured, pre_filter_str.as_deref()).await?;

    let name = Path::new(&out_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("eq-master.wav")
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

/// Two-pass render with DSP filters + loudnorm to `out_path` (24-bit broadcast WAV).
async fn run_loudnorm_render(
    app: &AppHandle,
    src: &str,
    out_path: &str,
    target_lufs: f64,
    m: &LoudnormMeasured,
    pre_filters: Option<&str>,
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

    // Pre-processing filters run before loudnorm so the final true-peak and loudness hit exact targets
    let af = match pre_filters {
        Some(p) => format!("{p},{loudnorm}"),
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
            "pcm_s24le", // 24-bit HD audio
            out_path,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg render failed to run: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let error_lines: Vec<&str> = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(3)
            .collect();
        let error_msg = if error_lines.is_empty() {
            "unknown ffmpeg error".to_string()
        } else {
            error_lines.into_iter().rev().collect::<Vec<&str>>().join(" | ")
        };
        return Err(format!(
            "ffmpeg render failed (exit {:?}): {}",
            out.status.code(),
            error_msg
        ));
    }
    Ok(())
}

/// `<app-data>/masters/<stem>.[profile.]master.wav`.
fn master_output_path(app: &AppHandle, src: &str, profile: Option<&str>) -> Result<String, String> {
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

    let filename = if let Some(p) = profile {
        format!("{stem}.{p}.master.wav")
    } else {
        format!("{stem}.master.wav")
    };

    Ok(dir.join(filename).to_string_lossy().into_owned())
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
    stderr.lines().rev().find_map(|line| {
        let i = line.find(&needle)?;
        line[i + needle.len()..].trim().parse::<f64>().ok()
    })
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
                "True peak is {tp:.1} dBTP (above {TRUE_PEAK_CEILING:.0} dBTP) — true-peak limiting will prevent inter-sample clipping on streaming codecs."
            ));
        }
    }

    if let Some(crest) = crest_db {
        if crest < 6.0 {
            recs.push(format!(
                "Low dynamic range ({crest:.1} dB crest) — track is already compressed; mastering will apply analog warmth without over-limiting."
            ));
        } else if crest > 16.0 {
            recs.push(format!(
                "Very dynamic ({crest:.1} dB crest) — gentle soft-knee glue will smoothly control peaks."
            ));
        }
    }

    if let (Some(low), Some(high)) = (low, high) {
        let tilt = low - high;
        if tilt > 18.0 {
            recs.push("Tonal balance leans bass-heavy/dull — high-pass sub cleanup and 11kHz air sheen will restore clarity.".into());
        } else if tilt < 6.0 {
            recs.push("Tonal balance leans bright/thin — warm analog saturation and low-end contouring will add body.".into());
        }
    }

    if recs.is_empty() {
        recs.push("No major issues detected — mastering will apply sub cleanup, analog glue, and true-peak normalization.".into());
    }
    recs
}
