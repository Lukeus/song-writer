//! Builds the song context handed to the model on every turn.
//!
//! The app knows things about a song that a chat window never could — the
//! written lyrics with their anchored chords, the tempo and key detected from
//! a recording, the chords it leans on — so the model is given all of it
//! rather than being asked to guess.
//!
//! The block is rebuilt from the database on every turn, so edits made while a
//! conversation is open are always reflected in the next reply.

use rusqlite::Connection;
use serde_json::Value;

use crate::db::{self, MediaFile};

/// Cap on the lyrics block. A whole song is far smaller than this; the limit
/// only guards against a runaway paste on a small local model's context.
const MAX_LYRIC_CHARS: usize = 8_000;

/// Cap on transcribed lyrics, which are noisier and less useful than the
/// written ones.
const MAX_TRANSCRIPT_CHARS: usize = 3_000;

/// Ignore chords occupying less of the song than this. The detector emits at
/// roughly beat resolution and misfires constantly, so the long tail is noise.
const MIN_CHORD_SHARE: f64 = 0.03;

/// How many chords to name. Past this the list stops describing the song.
const MAX_CHORDS_LISTED: usize = 8;

/// One entry in a media file's stored chord timeline. The analyzer emits an
/// entry per detected *change*, so a chord lasts until the next entry's `time`.
#[derive(serde::Deserialize)]
struct ChordHit {
    time: f64,
    label: String,
}

/// Assemble everything known about `song_id`, or `None` for a song with no
/// content worth sending.
pub fn build(conn: &Connection, song_id: i64) -> Option<String> {
    let song = db::get_song(conn, song_id).ok()?;
    let mut out = String::new();

    let title = song.title.trim();
    out.push_str(&format!(
        "# Song: {}\n",
        if title.is_empty() { "(untitled)" } else { title }
    ));

    let lyrics = flatten_doc(&song.content_json);
    let has_written_lyrics = !lyrics.trim().is_empty();
    if has_written_lyrics {
        out.push_str("\n## Lyrics as currently written in the editor\n");
        out.push_str(&truncate(&lyrics, MAX_LYRIC_CHARS));
        out.push('\n');
    } else {
        out.push_str("\n## Lyrics\nThe editor is empty — nothing has been written yet.\n");
    }

    let media = db::list_song_media(conn, song_id).unwrap_or_default();
    for recording in dedupe_recordings(&media) {
        if let Some(block) = describe_recording(recording) {
            out.push_str(&block);
        }
    }

    // The transcript is a near-duplicate of the written lyrics when both
    // exist, so it only earns its context space when nothing has been typed.
    if !has_written_lyrics {
        if let Some(m) = media.iter().find(|m| {
            m.lyrics.as_deref().map(|l| !l.trim().is_empty()).unwrap_or(false)
        }) {
            out.push_str(&format!(
                "\n## Lyrics transcribed from the recording ({})\n\
                 Machine transcription — expect mishearings.\n{}\n",
                m.name,
                truncate(m.lyrics.as_deref().unwrap_or(""), MAX_TRANSCRIPT_CHARS)
            ));
        }
    }

    if let Some(project_id) = song.logic_project_id {
        if let Ok(projects) = db::list_logic_projects(conn) {
            if let Some(p) = projects.iter().find(|p| p.id == project_id) {
                out.push_str(&format!("\n## Logic project\n{}\n", p.name));
            }
        }
    }

    Some(out)
}

/// Tempo / key / progression for one analyzed recording.
fn describe_recording(m: &MediaFile) -> Option<String> {
    if m.analysis_status != "done" {
        return None;
    }
    let mut facts: Vec<String> = Vec::new();
    if let Some(bpm) = m.bpm {
        facts.push(format!("{} BPM", round1(bpm)));
    }
    if let Some(key) = m.musical_key.as_deref().filter(|k| !k.is_empty()) {
        facts.push(format!("key of {key}"));
    }
    if let Some(secs) = m.duration_secs {
        facts.push(duration(secs));
    }
    let chords = chord_summary(m.chords_json.as_deref(), m.duration_secs);
    if facts.is_empty() && chords.is_none() {
        return None;
    }

    let mut block = format!("\n## Recording: {}\n", m.name);
    if !facts.is_empty() {
        block.push_str(&facts.join(" · "));
        block.push('\n');
    }
    if let Some(c) = chords {
        // Flagged as approximate so the model treats the tail with suspicion
        // rather than building suggestions on a misdetection.
        block.push_str(&format!(
            "Chords by share of playing time (automatic detection, approximate): {c}\n"
        ));
    }
    Some(block)
}

/// Summarise the chord timeline as the chords the song actually spends its
/// time on, most-present first.
///
/// The obvious rendering — replaying the timeline as `Bm → G → D → …` — is
/// worse than useless here. Measured against a real analysis, the detector
/// fires at roughly beat resolution and flips constantly, so the raw sequence
/// reads as hundreds of changes including chords foreign to the detected key.
/// Weighting each label by how long it is held cuts through that: the same
/// track that yields 307 "changes" is 45% Bm, 12% G, 7% C — which is simply
/// B minor, and is what a collaborator needs to know.
fn chord_summary(chords_json: Option<&str>, duration_secs: Option<f64>) -> Option<String> {
    let hits: Vec<ChordHit> = serde_json::from_str(chords_json?).ok()?;
    if hits.is_empty() {
        return None;
    }
    // The final chord runs to the end of the track when we know it, otherwise
    // to the last change (contributing nothing rather than a made-up span).
    let end = duration_secs.unwrap_or_else(|| hits.last().map(|h| h.time).unwrap_or(0.0));

    let mut totals: Vec<(String, f64)> = Vec::new();
    for (i, hit) in hits.iter().enumerate() {
        let label = hit.label.trim();
        if label.is_empty() || label.eq_ignore_ascii_case("N") {
            continue; // the analyzer's "no chord" marker
        }
        let next = hits.get(i + 1).map(|h| h.time).unwrap_or(end);
        let held = (next - hit.time).max(0.0);
        match totals.iter_mut().find(|(l, _)| l == label) {
            Some((_, sum)) => *sum += held,
            None => totals.push((label.to_string(), held)),
        }
    }

    let total: f64 = totals.iter().map(|(_, d)| d).sum();
    if total <= 0.0 {
        return None;
    }
    totals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let listed: Vec<String> = totals
        .iter()
        .take(MAX_CHORDS_LISTED)
        .filter(|(_, d)| d / total >= MIN_CHORD_SHARE)
        .map(|(label, d)| format!("{label} {:.0}%", 100.0 * d / total))
        .collect();
    if listed.is_empty() {
        return None;
    }
    Some(listed.join(", "))
}

/// Drop recordings that analyze identically — a master and the demo it came
/// from are the same song, and describing both twice wastes context.
fn dedupe_recordings(media: &[MediaFile]) -> Vec<&MediaFile> {
    let mut seen: Vec<(Option<i64>, Option<String>, Option<i64>)> = Vec::new();
    let mut out = Vec::new();
    for m in media {
        let signature = (
            m.bpm.map(|b| (b * 10.0).round() as i64),
            m.musical_key.clone(),
            m.duration_secs.map(|d| d.round() as i64),
        );
        // An unanalyzed file has an all-`None` signature; let those through
        // rather than collapsing every pending import into one.
        let analyzed = signature.0.is_some() || signature.1.is_some();
        if analyzed && seen.contains(&signature) {
            continue;
        }
        seen.push(signature);
        out.push(m);
    }
    out
}

/// Flatten a TipTap document into plain lines.
///
/// Chord nodes are atomic and sit immediately before the syllable they belong
/// to, so they are rendered inline as `[Am7]` — that keeps the alignment the
/// editor shows visually, in a form the model can read.
pub fn flatten_doc(content_json: &str) -> String {
    let doc: Value = match serde_json::from_str(content_json) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let mut lines: Vec<String> = Vec::new();
    walk_block(&doc, &mut lines);
    // Collapse runs of blank lines left by empty paragraphs, and trim the ends.
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        if line.trim().is_empty() && out.last().map(|l: &String| l.trim().is_empty()).unwrap_or(true)
        {
            continue;
        }
        out.push(line);
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    out.join("\n")
}

/// A song rewrite the model is proposing, pulled out of its reply.
#[derive(Debug, serde::Serialize)]
pub struct ProposedEdit {
    /// The lyrics from the block, in `[Bm]` notation.
    pub lyrics: String,
    /// Those lyrics as editor blocks, ready to apply.
    pub blocks: Vec<Value>,
    /// The reply with the block removed — the part to show as chat.
    pub prose: String,
}

/// Split a reply into its proposed song edit and its commentary.
///
/// Models wrap a rewrite in explanation, restate each original line before its
/// chorded version, and add markdown headings — so guessing which lines of a
/// reply are lyrics is hopeless. Instead the model is told to put the new song
/// in a fenced ```song block, and only that block is ever applied. A reply with
/// no block proposes no edit.
pub fn parse_reply(text: &str) -> Option<ProposedEdit> {
    let mut lyrics: Vec<&str> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut inside = false;
    let mut closed = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if !inside && !closed {
            if let Some(tag) = trimmed.strip_prefix("```") {
                let tag = tag.trim().to_ascii_lowercase();
                if tag == "song" || tag == "lyrics" {
                    inside = true;
                    continue;
                }
            }
            prose.push(line);
        } else if inside {
            if trimmed.starts_with("```") {
                inside = false;
                closed = true;
                continue;
            }
            lyrics.push(line);
        } else {
            prose.push(line);
        }
    }

    // An unterminated fence means the reply was cut short mid-block; keep what
    // arrived rather than discarding the whole edit.
    if lyrics.is_empty() {
        return None;
    }
    let lyrics = lyrics.join("\n").trim_matches('\n').to_string();
    Some(ProposedEdit {
        blocks: parse_lyric_blocks(&lyrics),
        lyrics,
        prose: join_prose(&prose),
    })
}

/// Join commentary lines, collapsing the blank runs left behind where the
/// block was lifted out so the text doesn't read with a hole in it.
fn join_prose(lines: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim().is_empty() && out.last().map(|l| l.trim().is_empty()).unwrap_or(true) {
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

/// Parse `[Bm]lyric` notation back into TipTap paragraph blocks — the inverse
/// of [`flatten_doc`], and the path by which the agent places chords over
/// syllables.
///
/// Because the model is shown the song in exactly this notation, it writes
/// chords back in the same form, and each `[X]` becomes a real inline chord
/// node anchored to the syllable that follows it.
///
/// A bracketed token is only treated as a chord if it actually parses as one,
/// so section markers a songwriter would write — `[Chorus]`, `[Verse 2]`,
/// `[Bridge]` — survive as ordinary text instead of turning into nonsense
/// chords.
pub fn parse_lyric_blocks(text: &str) -> Vec<Value> {
    text.lines().map(parse_lyric_line).collect()
}

fn parse_lyric_line(line: &str) -> Value {
    let mut content: Vec<Value> = Vec::new();
    let mut buf = String::new();
    let mut rest = line;

    while let Some(open) = rest.find('[') {
        if let Some(close_offset) = rest[open + 1..].find(']') {
            let close = open + 1 + close_offset;
            let inner = &rest[open + 1..close];
            if is_chord_symbol(inner) {
                buf.push_str(&rest[..open]);
                if !buf.is_empty() {
                    content.push(serde_json::json!({"type": "text", "text": buf}));
                    buf.clear();
                }
                content.push(serde_json::json!({
                    "type": "chord",
                    "attrs": { "chord": inner.trim() }
                }));
                rest = &rest[close + 1..];
                continue;
            }
        }
        // Not a chord, or an unclosed bracket: keep it as literal text.
        buf.push_str(&rest[..open + 1]);
        rest = &rest[open + 1..];
    }
    buf.push_str(rest);
    if !buf.is_empty() {
        content.push(serde_json::json!({"type": "text", "text": buf}));
    }

    if content.is_empty() {
        serde_json::json!({ "type": "paragraph" })
    } else {
        serde_json::json!({ "type": "paragraph", "content": content })
    }
}

/// Suffixes a chord symbol may be built from, longest-first so `maj` is
/// matched before `m` and `min` before `m`.
const CHORD_SUFFIX_TOKENS: &[&str] = &[
    "maj", "min", "sus", "add", "dim", "aug", "13", "11", "M", "m", "°", "ø", "Δ", "+", "-", "9",
    "7", "6", "5", "4", "2", "b", "#", "(", ")", " ",
];

/// Is `s` a chord symbol rather than prose?
///
/// Deliberately strict: an uppercase root note, an optional accidental, then a
/// suffix built only from recognised tokens, plus an optional `/bass`. This is
/// what keeps `[Chorus]` (a `C` followed by `horus`) from being read as a chord.
pub fn is_chord_symbol(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > 12 {
        return false;
    }
    let rest = match strip_note(s) {
        Some(rest) => rest,
        None => return false,
    };
    let mut rest = rest;
    loop {
        if rest.is_empty() {
            return true;
        }
        // A slash chord ends the symbol: everything after it must be a note.
        if let Some(bass) = rest.strip_prefix('/') {
            return strip_note(bass).map(str::is_empty).unwrap_or(false);
        }
        match CHORD_SUFFIX_TOKENS.iter().find(|t| rest.starts_with(**t)) {
            Some(token) => rest = &rest[token.len()..],
            None => return false,
        }
    }
}

/// Consume a root note (`A`–`G` with an optional accidental), returning the
/// remainder. Uppercase only — lowercase letters in prose would otherwise read
/// as chords far too easily.
fn strip_note(s: &str) -> Option<&str> {
    let mut chars = s.chars();
    let root = chars.next()?;
    if !('A'..='G').contains(&root) {
        return None;
    }
    let rest = &s[root.len_utf8()..];
    for accidental in ["#", "b", "♯", "♭"] {
        if let Some(stripped) = rest.strip_prefix(accidental) {
            return Some(stripped);
        }
    }
    Some(rest)
}

/// Emit one line per block-level node, recursing into containers.
fn walk_block(node: &Value, lines: &mut Vec<String>) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "doc" => children(node).iter().for_each(|c| walk_block(c, lines)),
        "paragraph" | "heading" => {
            let mut text = String::new();
            collect_inline(node, &mut text);
            // A heading is a section label ("Chorus"), worth marking as one.
            if kind == "heading" && !text.trim().is_empty() {
                lines.push(format!("[{}]", text.trim()));
            } else {
                lines.extend(text.split('\n').map(str::to_string));
            }
        }
        // Lists, blockquotes and the like: descend rather than drop content.
        _ => {
            let kids = children(node);
            if kids.is_empty() {
                let mut text = String::new();
                collect_inline(node, &mut text);
                if !text.is_empty() {
                    lines.push(text);
                }
            } else {
                kids.iter().for_each(|c| walk_block(c, lines));
            }
        }
    }
}

/// Concatenate the inline content of a block into `out`.
fn collect_inline(node: &Value, out: &mut String) {
    for child in children(node) {
        match child.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => out.push_str(child.get("text").and_then(Value::as_str).unwrap_or("")),
            "chord" => {
                let label = child
                    .get("attrs")
                    .and_then(|a| a.get("chord"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !label.is_empty() {
                    out.push_str(&format!("[{label}]"));
                }
            }
            "hardBreak" => out.push('\n'),
            _ => collect_inline(child, out),
        }
    }
}

fn children(node: &Value) -> Vec<&Value> {
    node.get("content")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

/// Cut at a character boundary, flagging that something was dropped.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n…(truncated)")
}

fn round1(v: f64) -> String {
    format!("{:.1}", v).trim_end_matches(".0").to_string()
}

fn duration(secs: f64) -> String {
    let total = secs.round() as i64;
    format!("{}:{:02}", total / 60, total % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_paragraphs_into_lines() {
        // The real shape stored by the editor.
        let doc = r#"{"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"There is a power in the people"}]},
            {"type":"paragraph","content":[{"type":"text","text":"and the ways that they connect."}]}
        ]}"#;
        assert_eq!(
            flatten_doc(doc),
            "There is a power in the people\nand the ways that they connect."
        );
    }

    #[test]
    fn renders_chords_inline_before_their_syllable() {
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"chord","attrs":{"chord":"Bm"}},
            {"type":"text","text":"There is a "},
            {"type":"chord","attrs":{"chord":"G"}},
            {"type":"text","text":"power"}
        ]}]}"#;
        assert_eq!(flatten_doc(doc), "[Bm]There is a [G]power");
    }

    #[test]
    fn marks_headings_as_section_labels() {
        let doc = r#"{"type":"doc","content":[
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Chorus"}]},
            {"type":"paragraph","content":[{"type":"text","text":"Connection is the power"}]}
        ]}"#;
        assert_eq!(flatten_doc(doc), "[Chorus]\nConnection is the power");
    }

    #[test]
    fn empty_doc_yields_nothing() {
        assert_eq!(flatten_doc(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#), "");
        assert_eq!(flatten_doc(""), "");
        assert_eq!(flatten_doc("not json"), "");
    }

    #[test]
    fn ranks_chords_by_time_held_not_by_hit_count() {
        // G is detected three times but only ever briefly; Bm is held. Counting
        // hits would rank G first, which is exactly the mistake to avoid.
        let raw = r#"[{"time":0.0,"label":"Bm"},{"time":6.0,"label":"G"},
                      {"time":6.5,"label":"Bm"},{"time":12.0,"label":"G"},
                      {"time":12.5,"label":"Bm"},{"time":18.0,"label":"G"}]"#;
        assert_eq!(
            chord_summary(Some(raw), Some(18.5)).unwrap(),
            "Bm 92%, G 8%"
        );
    }

    #[test]
    fn drops_chords_below_the_noise_threshold() {
        // A single beat-long misfire in an otherwise steady bar must not be
        // reported alongside the chord that carries the song.
        let raw = r#"[{"time":0.0,"label":"Bm"},{"time":99.0,"label":"A#m"},
                      {"time":99.5,"label":"Bm"}]"#;
        assert_eq!(chord_summary(Some(raw), Some(100.0)).unwrap(), "Bm 100%");
    }

    #[test]
    fn drops_the_analyzers_no_chord_marker() {
        let raw = r#"[{"time":0.0,"label":"N"},{"time":4.0,"label":"D"},{"time":8.0,"label":""}]"#;
        assert_eq!(chord_summary(Some(raw), Some(12.0)).unwrap(), "D 100%");
    }

    #[test]
    fn chord_summary_handles_missing_or_bad_data() {
        assert!(chord_summary(None, None).is_none());
        assert!(chord_summary(Some("garbage"), None).is_none());
        assert!(chord_summary(Some("[]"), None).is_none());
        // A timeline with a single entry and no known duration has no span to
        // measure, so it reports nothing rather than "100%".
        assert!(chord_summary(Some(r#"[{"time":0.0,"label":"Bm"}]"#), None).is_none());
    }

    /// Wrap blocks so a parse result can be fed straight back to `flatten_doc`.
    fn doc_of(blocks: Vec<Value>) -> String {
        serde_json::json!({"type": "doc", "content": blocks}).to_string()
    }

    #[test]
    fn parses_chords_into_inline_nodes() {
        let blocks = parse_lyric_blocks("[Bm]There is a [G]power");
        assert_eq!(
            blocks[0]["content"],
            serde_json::json!([
                {"type": "chord", "attrs": {"chord": "Bm"}},
                {"type": "text", "text": "There is a "},
                {"type": "chord", "attrs": {"chord": "G"}},
                {"type": "text", "text": "power"},
            ])
        );
    }

    #[test]
    fn round_trips_through_flatten() {
        // The notation the model is shown must be the notation it can write.
        let original = "[Bm]There is a [G]power in the people\n\n[F#m]and the ways that they [A]connect.";
        assert_eq!(flatten_doc(&doc_of(parse_lyric_blocks(original))), original);
    }

    #[test]
    fn separates_a_proposed_edit_from_its_commentary() {
        let reply = "Here is a chorded pass:\n\n\
                     ```song\n\
                     [Bm]There is a [G]power\n\
                     [C]Connection is the power\n\
                     ```\n\n\
                     Adjust to fit your melody.";
        let edit = parse_reply(reply).unwrap();
        assert_eq!(edit.lyrics, "[Bm]There is a [G]power\n[C]Connection is the power");
        assert_eq!(edit.blocks.len(), 2);
        assert_eq!(edit.prose, "Here is a chorded pass:\n\nAdjust to fit your melody.");
    }

    #[test]
    fn a_reply_without_a_block_proposes_nothing() {
        // Chords mentioned in prose must not be mistaken for an edit — this is
        // the case that previously dumped commentary into the song.
        let reply = "You could try [Bm] on the first line.\n\n**[Verse 1]**\n\
                     There is a power\n[Bm]There is a power";
        assert!(parse_reply(reply).is_none());
    }

    #[test]
    fn accepts_a_lyrics_tagged_fence() {
        assert!(parse_reply("```lyrics\n[G]hello\n```").is_some());
    }

    #[test]
    fn keeps_an_unterminated_block_from_a_cut_off_reply() {
        let edit = parse_reply("Working on it:\n```song\n[Bm]There is a [G]power").unwrap();
        assert_eq!(edit.lyrics, "[Bm]There is a [G]power");
    }

    #[test]
    fn ignores_an_ordinary_code_fence() {
        assert!(parse_reply("```\nnot lyrics\n```").is_none());
        assert!(parse_reply("```rust\nfn main() {}\n```").is_none());
    }

    #[test]
    fn anchors_a_chord_that_lands_mid_word() {
        // Real gemma4 output for this song. A chord falling inside a word is
        // the case the inline node exists for, so it must survive parsing.
        let blocks = parse_lyric_blocks("and the ways that they con[Em]nect.");
        assert_eq!(
            blocks[0]["content"],
            serde_json::json!([
                {"type": "text", "text": "and the ways that they con"},
                {"type": "chord", "attrs": {"chord": "Em"}},
                {"type": "text", "text": "nect."},
            ])
        );
    }

    #[test]
    fn section_markers_stay_as_text() {
        // "Chorus" starts with a C — the guard against reading it as a chord.
        let blocks = parse_lyric_blocks("[Chorus]");
        assert_eq!(
            blocks[0]["content"],
            serde_json::json!([{"type": "text", "text": "[Chorus]"}])
        );
    }

    #[test]
    fn recognises_real_chord_symbols() {
        for s in [
            "A", "Bm", "F#m", "Bb", "Am7", "Cmaj7", "Gsus4", "Bm7b5", "G/B", "F#m7/C#", "C°",
            "Daug", "Eadd9", "D#", "Bbmaj9",
        ] {
            assert!(is_chord_symbol(s), "should be a chord: {s}");
        }
    }

    #[test]
    fn rejects_prose_and_section_labels() {
        for s in [
            "Chorus", "Verse 1", "Bridge", "Intro", "Outro", "N", "", "guitar solo", "am7",
            "Fade out", "Ending", "x2",
        ] {
            assert!(!is_chord_symbol(s), "should not be a chord: {s}");
        }
    }

    #[test]
    fn unclosed_bracket_is_left_alone() {
        let blocks = parse_lyric_blocks("a [Bm line");
        assert_eq!(
            blocks[0]["content"],
            serde_json::json!([{"type": "text", "text": "a [Bm line"}])
        );
    }

    #[test]
    fn blank_lines_become_empty_paragraphs() {
        let blocks = parse_lyric_blocks("one\n\ntwo");
        assert_eq!(blocks.len(), 3);
        assert!(blocks[1].get("content").is_none());
    }

    #[test]
    fn formats_duration_as_minutes_and_seconds() {
        assert_eq!(duration(272.5), "4:33");
        assert_eq!(duration(65.0), "1:05");
    }
}
