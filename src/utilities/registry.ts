import { aiAgentUtility } from "./ai";
import { audioAnalysisUtility } from "./audio";
import { chordVoicingsUtility } from "./chords";
import { logicProjectsUtility } from "./logic";
import type { Utility } from "./types";

/**
 * Registered utilities, shown as tabs in the right-hand pane in order.
 * To add a feature: create a module under `utilities/` and append it here.
 */
export const UTILITIES: Utility[] = [
  audioAnalysisUtility,
  chordVoicingsUtility,
  logicProjectsUtility,
  aiAgentUtility,
];

