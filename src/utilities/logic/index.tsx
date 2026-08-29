import { LogicProjectsPanel } from "../../LogicProjectsPanel";
import { linkSongToProject } from "../../api";
import type { Utility, UtilityContext } from "../types";

/** Adapts the existing Logic Projects panel to the utility interface. */
function LogicUtility(ctx: UtilityContext) {
  const onLink = async (projectId: number | null) => {
    if (ctx.activeSongId == null) return;
    const updated = await linkSongToProject(ctx.activeSongId, projectId);
    ctx.onSongChanged(updated);
  };

  return (
    <LogicProjectsPanel
      linkedProjectId={ctx.activeSong?.logic_project_id ?? null}
      activeSongId={ctx.activeSongId}
      onLink={onLink}
      songOpen={ctx.activeSong != null}
    />
  );
}

export const logicProjectsUtility: Utility = {
  id: "logic-projects",
  title: "Logic",
  render: (ctx) => <LogicUtility {...ctx} />,
};
