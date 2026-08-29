import React from "react";

export type StudioIconName =
  | "eq"
  | "highpass"
  | "lowpass"
  | "lowshelf"
  | "highshelf"
  | "peaking"
  | "peak"
  | "notch"
  | "bypass"
  | "power"
  | "render"
  | "ai-agent"
  | "agent"
  | "ab-ref"
  | "ab"
  | "loop"
  | "waveform"
  | "tape"
  | "warmth"
  | "stereo"
  | "air"
  | "loudness"
  | "spectrum"
  | "polish";

export type StudioIconState = "rest" | "active" | "success" | "reference" | "disabled";

interface StudioIconProps extends React.SVGProps<SVGSVGElement> {
  name: StudioIconName;
  state?: StudioIconState;
  size?: number;
  color?: string;
  className?: string;
}

const STATE_COLORS: Record<StudioIconState, string> = {
  rest: "#5c6a78",
  active: "#7cd2ff",
  success: "#a3ffb0",
  reference: "#ffbb7c",
  disabled: "#243140",
};

export function StudioIcon({
  name,
  state = "rest",
  size = 20,
  color,
  className = "",
  style,
  ...props
}: StudioIconProps) {
  const strokeColor = color || STATE_COLORS[state] || STATE_COLORS.rest;

  const getPathData = (): string => {
    switch (name) {
      case "eq":
      case "polish":
        return "M5 3v6M5 13v4M10 3v3M10 10v7M15 3v9M15 16v1M3 11h4M8 8h4M13 14h4";
      case "highpass":
        return "M3 17 C7 17 8 5 13 4 L18 4";
      case "lowpass":
        return "M2 4 L7 4 C12 5 13 17 17 17";
      case "lowshelf":
        return "M2 13 L7 13 C11 13 12 8 18 8";
      case "highshelf":
        return "M2 15 L8 15 C12 15 13 6 18 6";
      case "peaking":
      case "peak":
        return "M2 12 L7 12 C9 12 9 6 10 6 C11 6 11 12 13 12 L18 12";
      case "notch":
        return "M2 8 L7 8 C9 8 9 14 10 14 C11 14 11 8 13 8 L18 8";
      case "bypass":
      case "power":
        return "M10 3v7M5.5 5.5a6.4 6.4 0 1 0 9 0";
      case "render":
        return "M10 3v9M6.5 9L10 12.5 13.5 9M4 15.5h12";
      case "ai-agent":
      case "agent":
        return "M10 2v3M10 15v3M2 10h3M15 10h3M4.5 4.5l2 2M13.5 13.5l2 2M15.5 4.5l-2 2M6.5 13.5l-2 2";
      case "ab-ref":
      case "ab":
        return "M4 14a8 8 0 0 1 12 0M10 14v-4";
      case "loop":
        return "M4 8V6a2 2 0 0 1 2-2h9M13 2l2 2-2 2M16 12v2a2 2 0 0 1-2 2H5M7 18l-2-2 2-2";
      case "waveform":
        return "M2 10h2M6 6v8M10 3v14M14 7v6M18 9v2";
      case "tape":
      case "warmth":
        return "M6.5 10a2.5 2.5 0 1 0 .01 0M13.5 10a2.5 2.5 0 1 0 .01 0M6.5 12.5h7";
      case "stereo":
        return "M7 5a5.5 5.5 0 1 0 0 10M13 5a5.5 5.5 0 1 1 0 10";
      case "air":
        return "M3 15 C8 15 9 9 14 8 L17 8M3 11 C7 11 9 6 13 5";
      case "loudness":
        return "M10 16a7 7 0 1 1 .01 0M10 16l3.5-5M8 16h4";
      case "spectrum":
        return "M2 16 C5 15 6 7 9 6 C12 5 13 11 16 10 L18 9";
      default:
        return "";
    }
  };

  const pathData = getPathData();
  if (!pathData) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke={strokeColor}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`studio-icon studio-icon--${name} studio-icon--${state} ${className}`}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
      {...props}
    >
      <path d={pathData} />
    </svg>
  );
}
