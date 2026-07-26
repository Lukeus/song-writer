import { useCallback, useEffect, useState } from "react";

/** How far a single arrow-key press nudges a pane, in pixels. */
const KEY_STEP = 16;

interface Props {
  /** Current width of the pane this handle controls, in pixels. */
  width: number;
  onChange: (next: number) => void;
  /**
   * Which side of the handle the pane sits on. For `"left"`, dragging right
   * widens it; for `"right"`, dragging right narrows it.
   */
  side: "left" | "right";
  min: number;
  max: number;
  /** Width restored on double-click. */
  defaultWidth: number;
  /** Accessible name, e.g. "Resize song list". */
  label: string;
}

/**
 * A draggable divider between two panes.
 *
 * The hit area is wider than the visible line so it is easy to grab, and the
 * handle takes pointer capture on press — that way the drag keeps tracking even
 * when the cursor runs ahead of the pane or leaves the window. Double-click
 * restores the default width; arrow keys nudge it for keyboard users.
 */
export function PaneResizer({ width, onChange, side, min, max, defaultWidth, label }: Props) {
  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(min, Math.round(n))),
    [min, max],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = width;
    handle.setPointerCapture(e.pointerId);
    // Without this, dragging across the editor selects lyrics as it goes.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      onChange(clamp(side === "left" ? startWidth + delta : startWidth - delta));
    };
    const finish = (ev: PointerEvent) => {
      document.body.style.userSelect = previousUserSelect;
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const towardsWider = side === "left" ? "ArrowRight" : "ArrowLeft";
    const towardsNarrower = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === towardsWider) onChange(clamp(width + KEY_STEP));
    else if (e.key === towardsNarrower) onChange(clamp(width - KEY_STEP));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="pane-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultWidth)}
      title={`${label} (double-click to reset)`}
    />
  );
}

/**
 * A pane width that survives restarts.
 *
 * Stored in `localStorage` rather than the database: it is a property of this
 * window, not of the song library, and it must be readable synchronously on
 * first paint so the layout doesn't jump.
 */
export function usePaneWidth(key: string, defaultWidth: number) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
  });

  useEffect(() => {
    localStorage.setItem(key, String(width));
  }, [key, width]);

  return [width, setWidth] as const;
}
