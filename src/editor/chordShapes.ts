/**
 * Chord shapes and voicing diagrams for Guitar and Piano.
 * Grounded in the Lukeus design system (Turn 3: 3a / 3b).
 */

import { parseChord, type ParsedChord } from "./musicTheory";

export interface GuitarVoicing {
  frets: number[]; // 6 strings: E A D G B e (-1 = muted/x, 0 = open/o, 1-4 = fret)
  baseFret?: number;
  fingering?: string;
}

export interface ChordShapeDef {
  roman?: string;
  guitar: GuitarVoicing;
  notes: number[]; // pitch classes 0..11
}

export interface GuitarCell {
  dot: boolean;
  stringIndex: number;
  fretIndex: number;
}

export interface GuitarMarker {
  glyph: string; // 'o', 'x', or ' '
}

export interface PianoKeyDef {
  whitePc: number;
  active: boolean;
  hasBlack: boolean;
  blackPc: number | null;
  blackActive: boolean;
}

export interface VoicingModel {
  name: string;
  roman: string;
  notes: string; // "A C E"
  pitchClasses: number[];
  guitar: {
    frets: number[];
    fingering: string;
    markers: GuitarMarker[];
    cells: GuitarCell[];
    baseFret: number;
  };
  piano: {
    keys: PianoKeyDef[];
  };
}

export const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const KNOWN_SHAPES: Record<string, ChordShapeDef> = {
  // Common Minor
  Am: {
    guitar: { frets: [-1, 0, 2, 2, 1, 0], fingering: "x02210" },
    notes: [9, 0, 4],
    roman: "i",
  },
  Dm: {
    guitar: { frets: [-1, -1, 0, 2, 3, 1], fingering: "xx0231" },
    notes: [2, 5, 9],
    roman: "iv",
  },
  Em: {
    guitar: { frets: [0, 2, 2, 0, 0, 0], fingering: "022000" },
    notes: [4, 7, 11],
    roman: "v",
  },
  Bm: {
    guitar: { frets: [-1, 2, 4, 4, 3, 2], baseFret: 2, fingering: "x13421" },
    notes: [11, 2, 6],
    roman: "ii",
  },
  "F#m": {
    guitar: { frets: [2, 4, 4, 2, 2, 2], baseFret: 2, fingering: "134111" },
    notes: [6, 9, 1],
    roman: "vi",
  },
  "C#m": {
    guitar: { frets: [-1, 4, 6, 6, 5, 4], baseFret: 4, fingering: "x13421" },
    notes: [1, 4, 8],
    roman: "iii",
  },
  Gm: {
    guitar: { frets: [3, 5, 5, 3, 3, 3], baseFret: 3, fingering: "134111" },
    notes: [7, 10, 2],
    roman: "v",
  },
  Cm: {
    guitar: { frets: [-1, 3, 5, 5, 4, 3], baseFret: 3, fingering: "x13421" },
    notes: [0, 3, 7],
    roman: "i",
  },

  // Common Major
  C: {
    guitar: { frets: [-1, 3, 2, 0, 1, 0], fingering: "x32010" },
    notes: [0, 4, 7],
    roman: "III",
  },
  G: {
    guitar: { frets: [3, 2, 0, 0, 0, 3], fingering: "320003" },
    notes: [7, 11, 2],
    roman: "VII",
  },
  F: {
    guitar: { frets: [-1, -1, 3, 2, 1, 1], fingering: "xx3211" },
    notes: [5, 9, 0],
    roman: "VI",
  },
  D: {
    guitar: { frets: [-1, -1, 0, 2, 3, 2], fingering: "xx0132" },
    notes: [2, 6, 9],
    roman: "IV",
  },
  A: {
    guitar: { frets: [-1, 0, 2, 2, 2, 0], fingering: "x01230" },
    notes: [9, 1, 4],
    roman: "I",
  },
  E: {
    guitar: { frets: [0, 2, 2, 1, 0, 0], fingering: "023100" },
    notes: [4, 8, 11],
    roman: "I",
  },
  Bb: {
    guitar: { frets: [-1, 1, 3, 3, 3, 1], baseFret: 1, fingering: "x12341" },
    notes: [10, 2, 5],
    roman: "bVII",
  },
  Eb: {
    guitar: { frets: [-1, -1, 1, 3, 4, 3], baseFret: 1, fingering: "xx1342" },
    notes: [3, 7, 10],
    roman: "bIII",
  },
  Ab: {
    guitar: { frets: [4, 6, 6, 5, 4, 4], baseFret: 4, fingering: "134211" },
    notes: [8, 0, 3],
    roman: "bVI",
  },
  B: {
    guitar: { frets: [-1, 2, 4, 4, 4, 2], baseFret: 2, fingering: "x12341" },
    notes: [11, 3, 6],
    roman: "VII",
  },

  // 7th / Dim / Extensions
  Am7: {
    guitar: { frets: [-1, 0, 2, 0, 1, 0], fingering: "x02010" },
    notes: [9, 0, 4, 7],
    roman: "i7",
  },
  Dm7: {
    guitar: { frets: [-1, -1, 0, 2, 1, 1], fingering: "xx0211" },
    notes: [2, 5, 9, 0],
    roman: "iv7",
  },
  Em7: {
    guitar: { frets: [0, 2, 0, 0, 0, 0], fingering: "020000" },
    notes: [4, 7, 11, 2],
    roman: "v7",
  },
  Cmaj7: {
    guitar: { frets: [-1, 3, 2, 0, 0, 0], fingering: "x32000" },
    notes: [0, 4, 7, 11],
    roman: "Imaj7",
  },
  Fmaj7: {
    guitar: { frets: [-1, -1, 3, 2, 1, 0], fingering: "xx3210" },
    notes: [5, 9, 0, 4],
    roman: "IVmaj7",
  },
  G7: {
    guitar: { frets: [3, 2, 0, 0, 0, 1], fingering: "320001" },
    notes: [7, 11, 2, 5],
    roman: "V7",
  },
  E7: {
    guitar: { frets: [0, 2, 0, 1, 0, 0], fingering: "020100" },
    notes: [4, 8, 11, 2],
    roman: "V7",
  },
  A7: {
    guitar: { frets: [-1, 0, 2, 0, 2, 0], fingering: "x02030" },
    notes: [9, 1, 4, 0],
    roman: "V7",
  },
  D7: {
    guitar: { frets: [-1, -1, 0, 2, 1, 2], fingering: "xx0213" },
    notes: [2, 6, 9, 0],
    roman: "V7",
  },
  Bdim: {
    guitar: { frets: [-1, 2, 3, 4, 3, -1], baseFret: 2, fingering: "x1243x" },
    notes: [11, 2, 5],
    roman: "ii°",
  },
  "F#dim": {
    guitar: { frets: [2, -1, 1, 2, 1, -1], baseFret: 1, fingering: "2x131x" },
    notes: [6, 9, 0],
    roman: "vii°",
  },
};

/** Generate piano key definitions for given pitch classes. */
export function createPianoKeys(notes: number[]): PianoKeyDef[] {
  return WHITE_KEYS.map((pc) => {
    const nextPc = (pc + 1) % 12;
    const hasBlack = !WHITE_KEYS.includes(nextPc);
    return {
      whitePc: pc,
      active: notes.includes(pc),
      hasBlack,
      blackPc: hasBlack ? nextPc : null,
      blackActive: hasBlack ? notes.includes(nextPc) : false,
    };
  });
}

/** Calculate pitch classes from a parsed chord. */
function calculatePitchClasses(parsed: ParsedChord): number[] {
  const root = parsed.root;
  switch (parsed.quality) {
    case "min":
      return [root, (root + 3) % 12, (root + 7) % 12];
    case "dim":
      return [root, (root + 3) % 12, (root + 6) % 12];
    case "aug":
      return [root, (root + 4) % 12, (root + 8) % 12];
    case "maj":
    default:
      return [root, (root + 4) % 12, (root + 7) % 12];
  }
}

/** Construct a complete VoicingModel for a chord symbol. */
export function getVoicing(symbol: string, defaultRoman?: string): VoicingModel {
  const cleanSymbol = symbol.trim();
  const known = KNOWN_SHAPES[cleanSymbol];

  let frets: number[] = [-1, 0, 2, 2, 1, 0];
  let fingering = "x02210";
  let notes = [9, 0, 4];
  let roman = defaultRoman || "";
  let baseFret = 1;

  if (known) {
    frets = known.guitar.frets;
    fingering = known.guitar.fingering || "";
    notes = known.notes;
    baseFret = known.guitar.baseFret || 1;
    if (!roman && known.roman) roman = known.roman;
  } else {
    const parsed = parseChord(cleanSymbol);
    if (parsed) {
      notes = calculatePitchClasses(parsed);
      // Construct a generic guitar shape if unknown
      frets = [-1, parsed.root % 4, (parsed.root + 2) % 4, (parsed.root + 2) % 4, (parsed.root + 1) % 4, 0];
      fingering = "x" + frets.slice(1).map((f) => (f < 0 ? "x" : f.toString())).join("");
    }
  }

  const markers: GuitarMarker[] = frets.map((f) => ({
    glyph: f === 0 ? "o" : f < 0 ? "x" : "\u00A0",
  }));

  const cells: GuitarCell[] = [];
  const FRET_ROWS = 4;
  for (let fret = 1; fret <= FRET_ROWS; fret++) {
    for (let str = 0; str < 6; str++) {
      cells.push({
        dot: frets[str] === fret,
        stringIndex: str,
        fretIndex: fret,
      });
    }
  }

  const pianoKeys = createPianoKeys(notes);
  const spelledNotes = notes.map((n) => NOTE_NAMES[n]).join(" ");

  return {
    name: cleanSymbol,
    roman,
    notes: spelledNotes,
    pitchClasses: notes,
    guitar: {
      frets,
      fingering,
      markers,
      cells,
      baseFret,
    },
    piano: {
      keys: pianoKeys,
    },
  };
}

/** Extract all unique chord names found in a TipTap document JSON. */
export function extractChordsFromDoc(doc: unknown): string[] {
  const chords: string[] = [];
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.type === "chord" && node.attrs?.chord) {
      const sym = String(node.attrs.chord).trim();
      if (sym && !chords.includes(sym)) chords.push(sym);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
  }
  walk(doc);
  return chords;
}
