import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ChordNode } from "./ChordNode";
import { suggestChordsInKey } from "./musicTheory";
import "./editor.css";

type ChordPMNode = { type: { name: string }; attrs: { chord?: string } };

/**
 * The chord "in focus": either a selected chord node, or — far more commonly,
 * since the node is a zero-width atom that's hard to click — the chord
 * immediately before or after the text cursor. This also keeps suggestions
 * visible right after you insert a chord (the cursor lands just after it).
 */
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

interface ChordEditorProps {
  /** Parsed TipTap document (or null/undefined for an empty editor). */
  content: JSONContent | null;
  /** Fires (debounced by the parent if desired) whenever the doc changes. */
  onChange: (doc: JSONContent) => void;
}

/**
 * Rich-text editor for lyrics with chords anchored above syllables.
 *
 * Workflow: place the cursor immediately before the syllable you want the chord
 * over, type the chord name in the toolbar field, and press Enter (or click
 * "Add chord above cursor"). The chord is inserted as an inline node at that
 * position, so it travels with the syllable when lines wrap.
 *
 * Music-theory smarts: when the cursor sits on/next to a chord (or you type one
 * in the box), a suggestions bar shows the diatonic chords in that chord's key
 * — click one to drop in the next chord of the progression.
 */
export function ChordEditor({ content, onChange }: ChordEditorProps) {
  const [chordInput, setChordInput] = useState("");
  const [selectedChord, setSelectedChord] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      ChordNode,
    ],
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    onSelectionUpdate: ({ editor }) => setSelectedChord(selectedChordOf(editor)),
    editorProps: {
      attributes: { class: "chord-editor-content" },
    },
  });

  // Suggest chords for what's being typed (active intent wins), else for the
  // chord at the cursor.
  const suggestionSource = chordInput.trim() || selectedChord || null;
  const suggestion = useMemo(
    () => (suggestionSource ? suggestChordsInKey(suggestionSource) : null),
    [suggestionSource],
  );

  // Keep the editor in sync when the parent swaps to a different song.
  useEffect(() => {
    if (!editor) return;
    const incoming = JSON.stringify(content ?? null);
    const current = JSON.stringify(editor.getJSON());
    if (incoming !== current) {
      editor.commands.setContent(content ?? { type: "doc", content: [{ type: "paragraph" }] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, editor]);

  if (!editor) return null;

  const insertChord = () => {
    const value = chordInput.trim();
    if (!value) return;
    editor.chain().focus().setChord(value).run();
    setChordInput("");
  };

  /**
   * Insert a suggested chord. If a chord node is selected, place the new chord
   * right after it (so you can build a progression); otherwise insert at the
   * cursor like the toolbar.
   */
  const applySuggestion = (symbol: string) => {
    const node = (editor.state.selection as { node?: { type: { name: string } } }).node;
    if (node && node.type.name === "chord") {
      editor.chain().focus().setTextSelection(editor.state.selection.to).setChord(symbol).run();
    } else {
      editor.chain().focus().setChord(symbol).run();
    }
  };

  return (
    <div className="chord-editor">
      <div className="chord-toolbar">
        <input
          className="chord-toolbar-input"
          placeholder="Chord (e.g. Am7)"
          value={chordInput}
          onChange={(e) => setChordInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              insertChord();
            }
          }}
        />
        <button className="chord-toolbar-btn" onClick={insertChord} title="Insert at cursor">
          ♯ Add chord above cursor
        </button>
        <span className="chord-toolbar-hint">
          Put the cursor before a syllable, then add the chord.
        </span>
      </div>

      {suggestion && (
        <div className="chord-suggestions">
          <span className="chord-suggestions-label">
            {chordInput.trim() ? "Key of " : "In "}
            <strong>{suggestion.keyName}</strong>
            {chordInput.trim() ? "" : " · click to add the next chord"}
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

      <EditorContent editor={editor} />
    </div>
  );
}
