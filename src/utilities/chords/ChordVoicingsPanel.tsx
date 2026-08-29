import { useMemo, useState } from "react";
import type { UtilityContext } from "../types";
import {
  extractChordsFromDoc,
  getVoicing,
  type VoicingModel,
} from "../../editor/chordShapes";
import { suggestChordsInKey } from "../../editor/musicTheory";

interface Props extends UtilityContext {
  initialInstrument?: "guitar" | "piano";
}

const DEFAULT_CHORDS = ["Am", "Dm", "Em", "F", "C", "G"];

export function ChordVoicingsPanel({ activeSong, insertBlocks }: Props) {
  const [instrument, setInstrument] = useState<"guitar" | "piano">("guitar");

  // Determine which chords to display:
  // 1. Chords used in the current document
  // 2. Or diatonic chords inferred from the first chord / key
  // 3. Fallback to DEFAULT_CHORDS
  const { chords, keyLabel } = useMemo(() => {
    let docChords: string[] = [];
    if (activeSong?.content_json) {
      try {
        const parsed = JSON.parse(activeSong.content_json);
        docChords = extractChordsFromDoc(parsed);
      } catch {
        docChords = [];
      }
    }

    if (docChords.length > 0) {
      const firstChord = docChords[0];
      const suggestion = suggestChordsInKey(firstChord);
      const romanMap = new Map<string, string>();
      if (suggestion) {
        suggestion.chords.forEach((c) => romanMap.set(c.symbol, c.roman));
      }

      const voicings = docChords.map((name) =>
        getVoicing(name, romanMap.get(name) || ""),
      );

      return {
        chords: voicings,
        keyLabel: suggestion ? `IN ${suggestion.keyName.toUpperCase()}` : "SONG CHORDS",
      };
    }

    // Default diatonic palette (A minor)
    const suggestion = suggestChordsInKey("Am");
    const voicings = DEFAULT_CHORDS.map((name) => {
      const match = suggestion?.chords.find((c) => c.symbol === name);
      return getVoicing(name, match?.roman || "");
    });

    return {
      chords: voicings,
      keyLabel: "IN A MINOR",
    };
  }, [activeSong]);

  const onVoicingClick = (voicing: VoicingModel) => {
    // Insert chord block / node if supported
    insertBlocks([
      {
        type: "paragraph",
        content: [
          {
            type: "chord",
            attrs: { chord: voicing.name },
          },
          {
            type: "text",
            text: " ",
          },
        ],
      },
    ]);
  };

  const isGuitar = instrument === "guitar";

  return (
    <div className="chord-voicings-panel">
      <div className="chord-voicings-header">
        <div className="chord-voicings-key">{keyLabel}</div>
        <div className="instrument-toggle">
          <button
            type="button"
            className={isGuitar ? "inst-btn active" : "inst-btn"}
            onClick={() => setInstrument("guitar")}
          >
            GUITAR
          </button>
          <button
            type="button"
            className={!isGuitar ? "inst-btn active" : "inst-btn"}
            onClick={() => setInstrument("piano")}
          >
            PIANO
          </button>
        </div>
      </div>

      <div className="chord-voicings-grid">
        {isGuitar ? (
          <div className="guitar-voicings-list">
            {chords.map((chord) => (
              <div
                key={chord.name}
                className="guitar-card"
                onClick={() => onVoicingClick(chord)}
                title={`Insert ${chord.name} at cursor`}
              >
                <div className="chord-card-title">
                  <span className="chord-name">{chord.name}</span>
                  {chord.roman && <span className="chord-roman">{chord.roman}</span>}
                </div>

                {/* String markers (o / x) */}
                <div className="guitar-markers">
                  {chord.guitar.markers.map((m, i) => (
                    <span key={i} className="guitar-marker">
                      {m.glyph}
                    </span>
                  ))}
                </div>

                {/* Fretboard grid */}
                <div className="guitar-fretboard">
                  {chord.guitar.cells.map((cell, i) => (
                    <span key={i} className="guitar-fret-cell">
                      {cell.dot && <span className="guitar-fret-dot" />}
                    </span>
                  ))}
                </div>

                {/* Fingering */}
                {chord.guitar.fingering && (
                  <div className="guitar-fingering">{chord.guitar.fingering}</div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="piano-voicings-list">
            {chords.map((chord) => (
              <div
                key={chord.name}
                className="piano-card"
                onClick={() => onVoicingClick(chord)}
                title={`Insert ${chord.name} at cursor`}
              >
                <div className="piano-card-info">
                  <span className="chord-name">{chord.name}</span>
                  <span className="chord-piano-meta">
                    {chord.roman ? `${chord.roman} · ` : ""}
                    {chord.notes}
                  </span>
                </div>

                {/* Piano keyboard representation */}
                <div className="piano-keyboard">
                  {chord.piano.keys.map((k, i) => (
                    <span key={i} className="piano-white-key">
                      {k.active && <span className="piano-white-dot" />}
                      {k.hasBlack && (
                        <span className="piano-black-key">
                          {k.blackActive && <span className="piano-black-dot" />}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="chord-voicings-footer">
        CLICK A VOICING TO INSERT IT AT THE CURSOR
      </div>
    </div>
  );
}
