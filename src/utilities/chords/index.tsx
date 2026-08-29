import { ChordVoicingsPanel } from "./ChordVoicingsPanel";
import type { Utility } from "../types";

export const chordVoicingsUtility: Utility = {
  id: "chord-voicings",
  title: "Chords",
  render: (ctx) => <ChordVoicingsPanel {...ctx} />,
};
