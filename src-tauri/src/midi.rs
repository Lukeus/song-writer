//! Standard MIDI File (SMF Type 1) generator for song chord progressions and section markers.
//!
//! Generates `.mid` files formatted specifically for drag-and-drop import into
//! Logic Pro (and other DAWs) to populate Global Marker and Chord/Instrument tracks.

use std::path::Path;

/// MIDI ticks per quarter note (PPQ). 480 is the DAW industry standard.
pub const PPQ: u16 = 480;

/// Parsed chord with MIDI note numbers for playback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiChord {
    pub symbol: String,
    pub notes: Vec<u8>,
    pub bass_note: Option<u8>,
    pub duration_ticks: u32,
}

/// A section marker (e.g. `[Verse 1]`, `[Chorus]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MidiMarker {
    pub name: String,
    pub tick: u32,
}

/// Parse a root note name into its base MIDI pitch (octave 4, Middle C = 60).
fn note_name_to_midi(name: &str) -> Option<u8> {
    let clean = name.trim();
    if clean.is_empty() {
        return None;
    }
    let letter = clean.chars().next()?.to_ascii_uppercase();
    let base = match letter {
        'C' => 60,
        'D' => 62,
        'E' => 64,
        'F' => 65,
        'G' => 67,
        'A' => 69,
        'B' => 71,
        _ => return None,
    };
    let mut modifier = 0i8;
    for c in clean[1..].chars() {
        match c {
            '#' | '♯' => modifier += 1,
            'b' | '♭' => modifier -= 1,
            _ => break,
        }
    }
    let result = (base as i16) + (modifier as i16);
    if (0..=127).contains(&result) {
        Some(result as u8)
    } else {
        None
    }
}

/// Convert a chord symbol (e.g. `Am7`, `G/B`, `Cmaj7`, `F#m`, `Bb`) into MIDI note numbers.
pub fn chord_symbol_to_midi_notes(symbol: &str) -> (Vec<u8>, Option<u8>) {
    let sym = symbol.trim();
    if sym.is_empty() {
        return (vec![60, 64, 67], None); // default C major
    }

    // Check for slash chords (e.g. "G/B", "D/F#")
    let (main_chord, bass_part) = if let Some((c, b)) = sym.split_once('/') {
        (c.trim(), Some(b.trim()))
    } else {
        (sym, None)
    };

    // Extract root note prefix (e.g. "C#", "Bb", "A")
    let mut root_len = 1;
    let chars: Vec<char> = main_chord.chars().collect();
    if chars.len() > 1 && (chars[1] == '#' || chars[1] == 'b' || chars[1] == '♯' || chars[1] == '♭') {
        root_len = 2;
    }
    let root_str = &main_chord[..root_len.min(main_chord.len())];
    let suffix = &main_chord[root_len.min(main_chord.len())..].to_ascii_lowercase();

    let root = note_name_to_midi(root_str).unwrap_or(60);

    // Semitone intervals relative to root
    let intervals: &[i8] = if suffix.starts_with("m7b5") || suffix.starts_with("ø") {
        &[0, 3, 6, 10] // half-diminished
    } else if suffix.starts_with("dim7") || suffix.starts_with("°7") || suffix.starts_with("o7") {
        &[0, 3, 6, 9] // diminished 7th
    } else if suffix.starts_with("dim") || suffix.starts_with("°") || suffix.starts_with("o") {
        &[0, 3, 6] // diminished triad
    } else if suffix.starts_with("maj7") || suffix.starts_with("m7+") || suffix.starts_with("δ") {
        &[0, 4, 7, 11] // major 7th
    } else if suffix.starts_with("m7") || suffix.starts_with("min7") {
        &[0, 3, 7, 10] // minor 7th
    } else if suffix.starts_with("7") || suffix.starts_with("dom7") {
        &[0, 4, 7, 10] // dominant 7th
    } else if suffix.starts_with("m") && !suffix.starts_with("maj") {
        &[0, 3, 7] // minor triad
    } else if suffix.starts_with("aug") || suffix.starts_with("+") {
        &[0, 4, 8] // augmented triad
    } else if suffix.starts_with("sus4") {
        &[0, 5, 7] // suspended 4th
    } else if suffix.starts_with("sus2") {
        &[0, 2, 7] // suspended 2nd
    } else if suffix.starts_with("5") || suffix.starts_with("power") {
        &[0, 7] // power chord
    } else if suffix.starts_with("add9") {
        &[0, 4, 7, 14]
    } else {
        &[0, 4, 7] // standard major triad
    };

    let mut notes: Vec<u8> = intervals
        .iter()
        .map(|&i| ((root as i16) + (i as i16)).clamp(0, 127) as u8)
        .collect();

    let bass_note = bass_part.and_then(note_name_to_midi).map(|n| {
        // Drop bass note to octave 2 (36–47) for deep foundation
        let mut b = n;
        while b > 48 {
            b = b.saturating_sub(12);
        }
        b
    });

    if notes.is_empty() {
        notes = vec![root];
    }

    (notes, bass_note)
}

/// Encode an unsigned integer as a MIDI Variable-Length Quantity (VLQ).
pub fn encode_vlq(mut value: u32) -> Vec<u8> {
    let mut buf = vec![(value & 0x7F) as u8];
    while value > 0x7F {
        value >>= 7;
        buf.push(((value & 0x7F) | 0x80) as u8);
    }
    buf.reverse();
    buf
}

/// Extract section markers and chord tokens from lyrics in `[Bm]lyric` notation.
pub fn parse_song_structure(lyrics_text: &str) -> (Vec<MidiMarker>, Vec<MidiChord>) {
    let mut markers: Vec<MidiMarker> = Vec::new();
    let mut chords: Vec<MidiChord> = Vec::new();

    let ticks_per_measure: u32 = (PPQ as u32) * 4; // Assuming 4/4 time
    let mut current_measure: u32 = 0;

    for line in lyrics_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Check if line is a section header, e.g. `[Verse 1]`, `[Chorus]`, `## Bridge`
        let section_name = if (trimmed.starts_with('[') && trimmed.ends_with(']'))
            || (trimmed.starts_with("##") || trimmed.starts_with('#'))
        {
            let name = trimmed
                .trim_matches(|c| c == '[' || c == ']' || c == '#')
                .trim();
            // Verify it's a section header and not a bare chord token
            if !crate::ai::context::is_chord_symbol(name) {
                Some(name.to_string())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(sec) = section_name {
            markers.push(MidiMarker {
                name: sec,
                tick: current_measure * ticks_per_measure,
            });
            continue;
        }

        // Extract inline chords from the line: tokens inside `[...]` that match chord symbols
        let mut line_chords: Vec<String> = Vec::new();
        let mut rest = trimmed;
        while let Some(open) = rest.find('[') {
            if let Some(close_offset) = rest[open + 1..].find(']') {
                let close = open + 1 + close_offset;
                let token = &rest[open + 1..close];
                if crate::ai::context::is_chord_symbol(token) {
                    line_chords.push(token.to_string());
                }
                rest = &rest[close + 1..];
            } else {
                break;
            }
        }

        if !line_chords.is_empty() {
            // Allocate measure beats evenly among chords on the line
            let chords_count = line_chords.len() as u32;
            let duration_per_chord = if chords_count == 1 {
                ticks_per_measure // 1 whole measure
            } else if chords_count == 2 {
                ticks_per_measure / 2 // 2 beats each
            } else {
                ticks_per_measure / chords_count
            };

            for sym in line_chords {
                let (notes, bass_note) = chord_symbol_to_midi_notes(&sym);
                chords.push(MidiChord {
                    symbol: sym,
                    notes,
                    bass_note,
                    duration_ticks: duration_per_chord,
                });
                current_measure += 1;
            }
        }
    }

    (markers, chords)
}

/// Generate a complete Standard MIDI File (SMF Type 1) binary buffer.
pub fn generate_smf_type1(
    bpm: f64,
    _key: Option<&str>,
    markers: &[MidiMarker],
    chords: &[MidiChord],
) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();

    // 1. Header Chunk: "MThd", length=6, format=1, num_tracks=2, division=PPQ
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes()); // Format 1
    out.extend_from_slice(&2u16.to_be_bytes()); // 2 tracks (Conductor + Chords)
    out.extend_from_slice(&PPQ.to_be_bytes());

    // 2. Track 0: Conductor Track (Tempo, Time Signature, Section Markers)
    let mut trk0_data: Vec<u8> = Vec::new();

    // Time Signature: 4/4 at tick 0 (0x00 0xFF 0x58 0x04 0x04 0x02 0x18 0x08)
    trk0_data.extend_from_slice(&[0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]);

    // Tempo: Microseconds per quarter note = (60,000,000 / BPM)
    let safe_bpm = if bpm > 20.0 && bpm < 400.0 { bpm } else { 120.0 };
    let us_per_qn = (60_000_000.0 / safe_bpm).round() as u32;
    let tempo_bytes = [
        ((us_per_qn >> 16) & 0xFF) as u8,
        ((us_per_qn >> 8) & 0xFF) as u8,
        (us_per_qn & 0xFF) as u8,
    ];
    trk0_data.extend_from_slice(&[0x00, 0xFF, 0x51, 0x03]);
    trk0_data.extend_from_slice(&tempo_bytes);

    // Section Markers
    let mut last_marker_tick: u32 = 0;
    for m in markers {
        let delta = m.tick.saturating_sub(last_marker_tick);
        last_marker_tick = m.tick;
        trk0_data.extend_from_slice(&encode_vlq(delta));
        let name_bytes = m.name.as_bytes();
        trk0_data.push(0xFF);
        trk0_data.push(0x06); // Meta event 0x06 = Marker
        trk0_data.extend_from_slice(&encode_vlq(name_bytes.len() as u32));
        trk0_data.extend_from_slice(name_bytes);
    }

    // End of Track for Track 0 (0x00 0xFF 0x2F 0x00)
    trk0_data.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);

    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(trk0_data.len() as u32).to_be_bytes());
    out.extend_from_slice(&trk0_data);

    // 3. Track 1: Chords Instrument Track
    let mut trk1_data: Vec<u8> = Vec::new();

    // Track Name Meta Event: "Chords" (0x00 0xFF 0x03 0x06 "Chords")
    trk1_data.extend_from_slice(&[0x00, 0xFF, 0x03, 0x06]);
    trk1_data.extend_from_slice(b"Chords");

    for chord in chords {
        let mut pitches = chord.notes.clone();
        if let Some(b) = chord.bass_note {
            if !pitches.contains(&b) {
                pitches.insert(0, b);
            }
        }

        // Note Ons (all at delta 0 except the first note on relative to previous note off)
        for &pitch in &pitches {
            trk1_data.extend_from_slice(&encode_vlq(0));
            trk1_data.push(0x90); // Note On, Channel 0
            trk1_data.push(pitch);
            trk1_data.push(80); // Velocity 80
        }

        // Note Offs: First Note Off after chord.duration_ticks, rest at delta 0
        for (i, &pitch) in pitches.iter().enumerate() {
            let delta = if i == 0 { chord.duration_ticks } else { 0 };
            trk1_data.extend_from_slice(&encode_vlq(delta));
            trk1_data.push(0x80); // Note Off, Channel 0
            trk1_data.push(pitch);
            trk1_data.push(0); // Velocity 0
        }
    }

    // End of Track for Track 1
    trk1_data.extend_from_slice(&[0x00, 0xFF, 0x2F, 0x00]);

    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(trk1_data.len() as u32).to_be_bytes());
    out.extend_from_slice(&trk1_data);

    out
}

/// Export song chords and markers as a Standard MIDI File (.mid).
pub fn export_song_midi_file(
    lyrics_text: &str,
    bpm: Option<f64>,
    key: Option<&str>,
    dest_path: &Path,
) -> Result<String, String> {
    let (markers, chords) = parse_song_structure(lyrics_text);
    let bytes = generate_smf_type1(bpm.unwrap_or(120.0), key, &markers, &chords);
    std::fs::write(dest_path, bytes).map_err(|e| format!("Failed to write MIDI file: {e}"))?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chord_symbols_to_midi() {
        let (c_notes, bass) = chord_symbol_to_midi_notes("C");
        assert_eq!(c_notes, vec![60, 64, 67]);
        assert_eq!(bass, None);

        let (am7_notes, _) = chord_symbol_to_midi_notes("Am7");
        assert_eq!(am7_notes, vec![69, 72, 76, 79]);

        let (slash_notes, slash_bass) = chord_symbol_to_midi_notes("G/B");
        assert_eq!(slash_notes, vec![67, 71, 74]);
        assert_eq!(slash_bass, Some(47)); // B in low bass octave (B2)
    }

    #[test]
    fn encodes_variable_length_quantities() {
        assert_eq!(encode_vlq(0), vec![0x00]);
        assert_eq!(encode_vlq(127), vec![0x7F]);
        assert_eq!(encode_vlq(128), vec![0x81, 0x00]);
        assert_eq!(encode_vlq(480), vec![0x83, 0x60]);
    }

    #[test]
    fn generates_valid_smf_header_and_tracks() {
        let lyrics = "[Verse 1]\n[C]There is a [G]power\n[Chorus]\n[Am]Hold [F]on\n";
        let (markers, chords) = parse_song_structure(lyrics);
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].name, "Verse 1");
        assert_eq!(markers[1].name, "Chorus");
        assert_eq!(chords.len(), 4);

        let bytes = generate_smf_type1(120.0, Some("C"), &markers, &chords);
        assert!(bytes.starts_with(b"MThd"));
        assert_eq!(&bytes[0..4], b"MThd");
        assert!(bytes.windows(4).any(|w| w == b"MTrk"));
    }
}
