//! Lightweight music-theory helpers for chord suggestions.
//!
//! Given a chord symbol (e.g. "Am7", "G", "F#m"), we infer a key — treating the
//! chord's root as the tonic, and its quality as choosing major vs. minor — and
//! return the seven diatonic triads of that key, spelled correctly (sequential
//! letter names) and labelled with roman numerals.

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Pitch class (0–11) for a spelled root note, accepting sharps and flats. */
const NOTE_TO_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

type Quality = "maj" | "min" | "dim" | "aug";

export interface ParsedChord {
  /** Pitch class of the root, 0–11. */
  root: number;
  /** Root as written, normalised (e.g. "F#", "Bb"). */
  rootName: string;
  quality: Quality;
  /** Everything after the root (e.g. "m7", "sus4"). */
  suffix: string;
}

export interface DiatonicChord {
  symbol: string;
  roman: string;
  /** True when this chord is the inferred tonic (the selected chord's key). */
  isTonic: boolean;
}

export interface KeySuggestion {
  /** Human-readable key, e.g. "A minor". */
  keyName: string;
  /** Whether the inferred key is major or minor. */
  mode: "major" | "minor";
  chords: DiatonicChord[];
}

/** Parse a chord symbol into root + quality, or null if unrecognised. */
export function parseChord(symbol: string): ParsedChord | null {
  const m = symbol.trim().match(/^([A-Ga-g])([#b♯♭]?)(.*)$/);
  if (!m) return null;
  const accidental = m[2].replace("♯", "#").replace("♭", "b");
  const rootName = m[1].toUpperCase() + accidental;
  const root = NOTE_TO_PC[rootName];
  if (root === undefined) return null;
  const suffix = m[3].trim();
  return { root, rootName, quality: chordQuality(suffix), suffix };
}

/** Classify a chord suffix into a base triad quality. */
function chordQuality(suffix: string): Quality {
  const s = suffix.toLowerCase();
  if (s.startsWith("maj")) return "maj"; // maj7, maj9 — major triad
  if (s.startsWith("m") && !s.startsWith("maj")) return "min"; // m, min, m7…
  if (s.startsWith("dim") || s.startsWith("°") || s.startsWith("o")) return "dim";
  if (s.startsWith("aug") || s.startsWith("+")) return "aug";
  return "maj"; // bare, 7, 9, sus, 6, add… resolve to a major triad root
}

/** Spell a pitch class using a specific letter, adding accidentals as needed. */
function spell(letterIndex: number, targetPc: number): string {
  const letter = LETTERS[letterIndex % 7];
  const diff = (targetPc - LETTER_PC[letter] + 12) % 12;
  switch (diff) {
    case 0: return letter;
    case 1: return `${letter}#`;
    case 2: return `${letter}##`;
    case 11: return `${letter}b`;
    case 10: return `${letter}bb`;
    default: return letter;
  }
}

const MAJOR = {
  intervals: [0, 2, 4, 5, 7, 9, 11],
  quals: ["", "m", "m", "", "", "m", "dim"],
  romans: ["I", "ii", "iii", "IV", "V", "vi", "vii°"],
};
const MINOR = {
  intervals: [0, 2, 3, 5, 7, 8, 10],
  quals: ["m", "dim", "", "m", "m", "", ""],
  romans: ["i", "ii°", "III", "iv", "v", "VI", "VII"],
};

/**
 * Suggest the diatonic chords sharing a key with `chordSymbol`.
 *
 * The chord's root is treated as the tonic; a minor quality picks the minor key,
 * everything else the major key. Returns null if the symbol can't be parsed.
 */
export function suggestChordsInKey(chordSymbol: string): KeySuggestion | null {
  const parsed = parseChord(chordSymbol);
  if (!parsed) return null;

  const mode = parsed.quality === "min" ? "minor" : "major";
  const scale = mode === "minor" ? MINOR : MAJOR;
  const tonicLetterIndex = LETTERS.indexOf(parsed.rootName[0] as (typeof LETTERS)[number]);

  const chords: DiatonicChord[] = scale.intervals.map((iv, i) => {
    const pc = (parsed.root + iv) % 12;
    const name = spell(tonicLetterIndex + i, pc);
    return {
      symbol: name + scale.quals[i],
      roman: scale.romans[i],
      isTonic: i === 0,
    };
  });

  return { keyName: `${parsed.rootName} ${mode}`, mode, chords };
}

const CHROMATIC_SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHROMATIC_FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/**
 * Transpose a single root note by `semitones`.
 */
export function transposeRootNote(
  root: string,
  semitones: number,
  preferFlats?: boolean,
): string {
  const clean = root.trim().replace("♯", "#").replace("♭", "b");
  const pc = NOTE_TO_PC[clean];
  if (pc === undefined) return root;

  const targetPc = (pc + (semitones % 12) + 12) % 12;
  const isFlat = preferFlats ?? (clean.includes("b") || clean === "F");
  return isFlat ? CHROMATIC_FLATS[targetPc] : CHROMATIC_SHARPS[targetPc];
}

/**
 * Transpose a chord symbol (including slash chords like G/B, Am7/G, C#m7b5) by `semitones`.
 */
export function transposeChord(symbol: string, semitones: number): string {
  if (!symbol || semitones === 0) return symbol;
  const sym = symbol.trim();

  if (sym.includes("/")) {
    const parts = sym.split("/");
    const mainTransposed = transposeChord(parts[0], semitones);
    const bassTransposed = parts[1]
      ? transposeRootNote(parts[1], semitones, parts[1].includes("b") || parts[1].includes("♭"))
      : "";
    return bassTransposed ? `${mainTransposed}/${bassTransposed}` : mainTransposed;
  }

  const parsed = parseChord(sym);
  if (!parsed) return symbol;

  const preferFlats = parsed.rootName.includes("b") || parsed.rootName.includes("♭");
  const newRoot = transposeRootNote(parsed.rootName, semitones, preferFlats);
  return `${newRoot}${parsed.suffix}`;
}

/**
 * Recursively transposes all chord nodes within a TipTap JSONContent document.
 */
export function transposeDoc(doc: any, semitones: number): any {
  if (!doc || semitones === 0) return doc;

  if (Array.isArray(doc)) {
    return doc.map((item) => transposeDoc(item, semitones));
  }

  if (typeof doc === "object") {
    const nextNode: any = { ...doc };
    if (nextNode.type === "chord" && nextNode.attrs?.chord) {
      nextNode.attrs = {
        ...nextNode.attrs,
        chord: transposeChord(nextNode.attrs.chord, semitones),
      };
    }
    if (nextNode.content && Array.isArray(nextNode.content)) {
      nextNode.content = nextNode.content.map((child: any) => transposeDoc(child, semitones));
    }
    return nextNode;
  }

  return doc;
}

