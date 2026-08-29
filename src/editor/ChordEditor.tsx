import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ChordNode } from "./ChordNode";
import { suggestChordsInKey, transposeDoc } from "./musicTheory";
import { countLineSyllables, getRhymeSuggestions } from "./lyricHelpers";
import { getVoicing, type VoicingModel } from "./chordShapes";
import "./editor.css";

type ChordPMNode = { type: { name: string }; attrs: { chord?: string } };

function selectedChordOf(editor: { state: { selection: unknown } } | null): string | null {
  if (!editor) return null;
  const sel = editor.state.selection as {
    node?: ChordPMNode;
    $from?: { nodeBefore?: ChordPMNode | null; nodeAfter?: ChordPMNode | null };
  };
  const isChord = (n?: ChordPMNode | null) => n != null && n.type.name === "chord";
  if (isChord(sel.node)) return sel.node!.attrs.chord ?? null;
  if (isChord(sel.$from?.nodeBefore)) return sel.$from!.nodeBefore!.attrs.chord ?? null;
  if (isChord(sel.$from?.nodeAfter)) return sel.$from!.nodeAfter!.attrs.chord ?? null;
  return null;
}

function getCurrentLineText(editor: any): string {
  if (!editor) return "";
  try {
    const { $from } = editor.state.selection;
    return $from.parent?.textContent || "";
  } catch {
    return "";
  }
}

interface ChordEditorProps {
  content: JSONContent | null;
  onChange: (doc: JSONContent) => void;
}

export function ChordEditor({ content, onChange }: ChordEditorProps) {
  const [chordInput, setChordInput] = useState("");
  const [selectedChord, setSelectedChord] = useState<string | null>(null);
  const [currentLine, setCurrentLine] = useState("");
  const [instrument, setInstrument] = useState<"guitar" | "piano">("guitar");
  const [showInlineVoicings, setShowInlineVoicings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [StarterKit, ChordNode],
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
      setCurrentLine(getCurrentLineText(editor));
    },
    onSelectionUpdate: ({ editor }) => {
      setSelectedChord(selectedChordOf(editor));
      setCurrentLine(getCurrentLineText(editor));
    },
    editorProps: {
      attributes: { class: "chord-editor-content" },
    },
  });

  // Calculate syllables and rhymes for active line
  const syllableCount = useMemo(() => countLineSyllables(currentLine), [currentLine]);
  const rhymeInfo = useMemo(() => {
    const words = currentLine.trim().split(/\s+/).filter(Boolean);
    const lastWord = words[words.length - 1] || "";
    return getRhymeSuggestions(lastWord);
  }, [currentLine]);

  // Suggestions for toolbar
  const suggestionSource = chordInput.trim() || selectedChord || null;
  const suggestion = useMemo(
    () => (suggestionSource ? suggestChordsInKey(suggestionSource) : null),
    [suggestionSource],
  );

  // Active chord for the inline strip
  const activeChordForStrip = selectedChord || (suggestion?.chords[0]?.symbol ?? "Am");

  // Generate voicings for inline strip (diatonic progression around the active chord)
  const inlineVoicings = useMemo<VoicingModel[]>(() => {
    if (suggestion && suggestion.chords.length > 0) {
      return suggestion.chords.map((c) => getVoicing(c.symbol, c.roman));
    }
    const defaultList = ["Am", "Dm", "Em", "F", "C", "G"];
    return defaultList.map((c) => getVoicing(c));
  }, [suggestion]);

  // Keep editor content in sync when parent song changes
  useEffect(() => {
    if (!editor) return;
    const incoming = JSON.stringify(content ?? null);
    const current = JSON.stringify(editor.getJSON());
    if (incoming !== current) {
      editor.commands.setContent(
        content ?? { type: "doc", content: [{ type: "paragraph" }] },
      );
      setCurrentLine(getCurrentLineText(editor));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor]);

  // Global hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMetaOrCtrl = e.metaKey || e.ctrlKey;
      if (isMetaOrCtrl && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (isMetaOrCtrl && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        setInstrument((prev) => (prev === "guitar" ? "piano" : "guitar"));
      } else if (isMetaOrCtrl && e.key === "/") {
        e.preventDefault();
        if (editor) {
          insertSection("VERSE");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor]);

  if (!editor) return null;

  const insertSection = (name: string) => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: name.toUpperCase() }],
        },
        { type: "paragraph" },
      ])
      .run();
  };

  const insertChord = () => {
    const value = chordInput.trim();
    if (!value) return;
    editor.chain().focus().setChord(value).run();
    setChordInput("");
  };

  const applySuggestion = (symbol: string) => {
    const node = (editor.state.selection as { node?: { type: { name: string } } }).node;
    if (node && node.type.name === "chord") {
      editor
        .chain()
        .focus()
        .setTextSelection(editor.state.selection.to)
        .setChord(symbol)
        .run();
    } else {
      editor.chain().focus().setChord(symbol).run();
    }
  };

  const handleTranspose = (semitones: number) => {
    if (!editor || semitones === 0) return;
    const currentDoc = editor.getJSON();
    const transposed = transposeDoc(currentDoc, semitones);
    editor.commands.setContent(transposed);
    onChange(transposed);
  };

  const isGuitar = instrument === "guitar";

  return (
    <div className="chord-editor">
      {/* Chord Input Toolbar */}
      <div className="chord-toolbar">
        <input
          ref={inputRef}
          className="chord-toolbar-input"
          placeholder="chord (e.g. Am7)"
          value={chordInput}
          onChange={(e) => setChordInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              insertChord();
            }
          }}
        />
        <button
          className="chord-toolbar-btn"
          onClick={insertChord}
          title="Insert chord at cursor (⌘K)"
        >
          add chord above cursor
        </button>
        <div className="transpose-group">
          <button
            type="button"
            className="transpose-btn"
            onClick={() => handleTranspose(-1)}
            title="Transpose all chords down 1 semitone (-1)"
          >
            ♭ −1
          </button>
          <span className="transpose-label">TRANSPOSE</span>
          <button
            type="button"
            className="transpose-btn"
            onClick={() => handleTranspose(1)}
            title="Transpose all chords up 1 semitone (+1)"
          >
            ♯ +1
          </button>
        </div>
        <button
          type="button"
          className={showInlineVoicings ? "chord-strip-toggle active" : "chord-strip-toggle"}
          onClick={() => setShowInlineVoicings((v) => !v)}
          title="Toggle inline voicings strip (⌘G)"
        >
          voicings strip
        </button>
        <div className="section-insert-group">
          <button
            type="button"
            className="section-insert-btn"
            onClick={() => insertSection("VERSE")}
            title="Insert Verse section (⌘/)"
          >
            + verse
          </button>
          <button
            type="button"
            className="section-insert-btn chorus"
            onClick={() => insertSection("CHORUS")}
            title="Insert Chorus section"
          >
            + chorus
          </button>
          <button
            type="button"
            className="section-insert-btn"
            onClick={() => insertSection("BRIDGE")}
            title="Insert Bridge section"
          >
            + bridge
          </button>
        </div>
        <span className="chord-toolbar-hint">
          put cursor before syllable to add chord · ⌘K
        </span>
      </div>

      {/* Diatonic Suggestions Bar */}
      {suggestion && (
        <div className="chord-suggestions">
          <span className="chord-suggestions-label">
            IN <strong>{suggestion.keyName}</strong> · click to add the next chord
          </span>
          <div className="chord-suggestions-list">
            {suggestion.chords.map((c) => (
              <button
                key={c.roman}
                className={c.isTonic ? "chord-chip tonic" : "chord-chip"}
                onClick={() => applySuggestion(c.symbol)}
                title={`${c.roman} of ${suggestion.keyName}`}
              >
                <span className="chip-symbol">{c.symbol}</span>
                <span className="chip-roman">{c.roman}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Rich Lyric / Chord Canvas */}
      <EditorContent editor={editor} className="chord-editor-scroll" />

      {/* Inline Voicings Strip (Option 3b) */}
      {showInlineVoicings && (
        <div className="inline-voicings-strip">
          <div className="inline-strip-header">
            <span className="inline-strip-label">
              VOICINGS · <b className="active-chord-name">{activeChordForStrip}</b> AT CURSOR
            </span>
            <div className="instrument-toggle compact">
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
            <span className="inline-strip-shortcut">⌘G TOGGLE INSTRUMENT</span>
          </div>

          <div className="inline-strip-cards">
            {isGuitar ? (
              <div className="inline-guitar-row">
                {inlineVoicings.map((chord) => (
                  <div
                    key={chord.name}
                    className="inline-guitar-card"
                    onClick={() => applySuggestion(chord.name)}
                    title={`Insert ${chord.name}`}
                  >
                    <span className="inline-chord-name">{chord.name}</span>
                    <div className="inline-guitar-markers">
                      {chord.guitar.markers.map((m, i) => (
                        <span key={i} className="inline-marker">
                          {m.glyph}
                        </span>
                      ))}
                    </div>
                    <div className="inline-guitar-fretboard">
                      {chord.guitar.cells.map((cell, i) => (
                        <span key={i} className="inline-fret-cell">
                          {cell.dot && <span className="inline-fret-dot" />}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="inline-piano-row">
                {inlineVoicings.map((chord) => (
                  <div
                    key={chord.name}
                    className="inline-piano-card"
                    onClick={() => applySuggestion(chord.name)}
                    title={`Insert ${chord.name}`}
                  >
                    <span className="inline-chord-name">{chord.name}</span>
                    <div className="inline-piano-keyboard">
                      {chord.piano.keys.map((k, i) => (
                        <span key={i} className="inline-piano-white-key">
                          {k.active && <span className="inline-piano-white-dot" />}
                          {k.hasBlack && (
                            <span className="inline-piano-black-key">
                              {k.blackActive && <span className="inline-piano-black-dot" />}
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                    <span className="inline-chord-notes">{chord.notes}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Editor Status Bar */}
      <div className="chord-editor-statusbar">
        <span className="status-syllables">
          LINE · {syllableCount} {syllableCount === 1 ? "SYLLABLE" : "SYLLABLES"}
        </span>

        {rhymeInfo && rhymeInfo.rhymes.length > 0 && (
          <span className="status-rhymes">
            RHYMES WITH &quot;{rhymeInfo.baseWord.toUpperCase()}&quot; ·{" "}
            {rhymeInfo.rhymes.map((r, i) => (
              <button
                key={r}
                type="button"
                className="status-rhyme-btn"
                onClick={() => {
                  editor.chain().focus().insertContent(` ${r}`).run();
                }}
                title={`Insert "${r}" at cursor`}
              >
                {r}{i < rhymeInfo.rhymes.length - 1 ? "," : ""}
              </button>
            ))}
          </span>
        )}

        <span className="status-shortcuts">⌘K CHORD · ⌘/ SECTION · ⌘G INSTRUMENT</span>
      </div>
    </div>
  );
}
