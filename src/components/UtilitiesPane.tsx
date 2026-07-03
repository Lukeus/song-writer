import { useState } from "react";
import { UTILITIES } from "../utilities/registry";
import type { UtilityContext } from "../utilities/types";

/** Tabbed host for the registered utilities. Renders the active utility panel. */
export function UtilitiesPane({ ctx }: { ctx: UtilityContext }) {
  const [activeId, setActiveId] = useState(UTILITIES[0]?.id ?? null);
  const active = UTILITIES.find((u) => u.id === activeId) ?? UTILITIES[0];

  return (
    <div className="utilities-pane">
      <nav className="utilities-tabs">
        {UTILITIES.map((u) => (
          <button
            key={u.id}
            className={u.id === active?.id ? "utility-tab active" : "utility-tab"}
            onClick={() => setActiveId(u.id)}
          >
            {u.title}
          </button>
        ))}
      </nav>
      <div className="utilities-body">{active?.render(ctx)}</div>
    </div>
  );
}
