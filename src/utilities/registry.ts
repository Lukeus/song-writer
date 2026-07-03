import { audioAnalysisUtility } from "./audio";
import { logicProjectsUtility } from "./logic";
import type { Utility } from "./types";

/**
 * Registered utilities, shown as tabs in the right-hand pane in order.
 * To add a feature: create a module under `utilities/` and append it here.
 */
export const UTILITIES: Utility[] = [audioAnalysisUtility, logicProjectsUtility];
