import { Node, mergeAttributes } from "@tiptap/core";

/**
 * An inline, atomic `chord` node.
 *
 * The chord label lives in an attribute (not as editable text), and the node is
 * inserted *into the lyric flow* immediately before the syllable it belongs to.
 * Because it's a real inline node at a real document position, it stays anchored
 * to that syllable no matter how the line wraps — the chord and its word move
 * together.
 *
 * Visually the node is zero-width (so it doesn't push lyrics apart) and renders
 * its label in an absolutely-positioned span sitting *above* the baseline. The
 * paragraph reserves head-room via CSS (see `editor.css`) so labels aren't
 * clipped.
 */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    chord: {
      /** Insert a chord at the current selection. */
      setChord: (chord: string) => ReturnType;
    };
  }
}

export const ChordNode = Node.create({
  name: "chord",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      chord: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-chord") ?? "",
        renderHTML: (attrs) => ({ "data-chord": attrs.chord }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-chord]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Outer span is the zero-width anchor; inner span is the floating label.
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "chord" }),
      ["span", { class: "chord-label", contenteditable: "false" }, HTMLAttributes["data-chord"] ?? ""],
    ];
  },

  addCommands() {
    return {
      setChord:
        (chord: string) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name, attrs: { chord } })
            .run(),
    };
  },
});
