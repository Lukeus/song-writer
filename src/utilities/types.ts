import type { ReactNode } from "react";
import type { Song } from "../api";

/**
 * Shared context passed to every utility panel. It exposes the currently open
 * song and a callback to bubble a changed song back up to the app shell (e.g.
 * after linking a Logic project).
 */
export interface UtilityContext {
  activeSongId: number | null;
  activeSong: Song | null;
  /** Merge an updated song into app state. */
  onSongChanged: (song: Song) => void;
  /** Append text (one paragraph per line) into the active song's editor. */
  insertLyrics: (text: string) => void;
}

/**
 * A self-contained feature shown as a tab in the right-hand utilities pane.
 * Register new utilities in `registry.ts`.
 */
export interface Utility {
  /** Stable id (used as the tab key). */
  id: string;
  /** Tab label. */
  title: string;
  /** Render the panel for the given context. */
  render: (ctx: UtilityContext) => ReactNode;
}
