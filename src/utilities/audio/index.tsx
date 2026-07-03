import { AudioAnalysisPanel } from "./AudioAnalysisPanel";
import type { Utility } from "../types";

export const audioAnalysisUtility: Utility = {
  id: "audio-analysis",
  title: "Audio Analysis",
  render: (ctx) => <AudioAnalysisPanel {...ctx} />,
};
