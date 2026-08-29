import type { MediaFile } from "../api";

export type EqBandType = "highpass" | "lowshelf" | "peaking" | "highshelf" | "lowpass";

export interface EqBand {
  id: number;
  name: string;
  type: EqBandType;
  frequency: number; // 20 - 20000 Hz
  gain: number;      // -18 to +18 dB (ignored for HPF/LPF)
  q: number;         // 0.1 to 18.0
  enabled: boolean;
  color: string;
}

export interface EqPreset {
  id: string;
  name: string;
  description: string;
  bands: Omit<EqBand, "id" | "color">[];
}

export type ActiveAudioSource = "primary" | "reference";

export interface GlobalAudioState {
  primaryTrack: MediaFile | null;
  referenceTrack: MediaFile | null;
  activeSource: ActiveAudioSource;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number; // 0.0 to 1.0
  isMuted: boolean;
  isEqBypassed: boolean;
  eqBands: EqBand[];
  isComparing: boolean;
  refVolumeOffset: number; // dB offset for level matching
  syncPlayheads: boolean;
  loop: boolean;
  // Audio node getters for canvas visualizers
  getPrimaryAnalyser: () => AnalyserNode | null;
  getRefAnalyser: () => AnalyserNode | null;
  getAudioContext: () => AudioContext | null;
  getBiquadFilterNodes: () => BiquadFilterNode[];
  // Control actions
  playTrack: (track: MediaFile) => void;
  setReferenceTrack: (track: MediaFile | null) => void;
  setActiveSource: (source: ActiveAudioSource) => void;
  togglePlay: () => void;
  pause: () => void;
  seek: (timeInSecs: number) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  toggleEqBypass: () => void;
  updateEqBand: (id: number, updates: Partial<EqBand>) => void;
  setEqBands: (bands: EqBand[]) => void;
  applyPreset: (preset: EqPreset) => void;
  resetEq: () => void;
  setRefVolumeOffset: (offsetDb: number) => void;
  setSyncPlayheads: (sync: boolean) => void;
  setLoop: (loop: boolean) => void;
}

export const DEFAULT_EQ_BANDS: EqBand[] = [
  { id: 1, name: "Sub Cut", type: "highpass", frequency: 28, gain: 0, q: 0.707, enabled: true, color: "#ef4444" },
  { id: 2, name: "Low Shelf", type: "lowshelf", frequency: 90, gain: 0, q: 0.707, enabled: true, color: "#f97316" },
  { id: 3, name: "Low Mid", type: "peaking", frequency: 280, gain: 0, q: 1.2, enabled: true, color: "#eab308" },
  { id: 4, name: "Body Mid", type: "peaking", frequency: 1000, gain: 0, q: 1.4, enabled: true, color: "#22c55e" },
  { id: 5, name: "High Mid", type: "peaking", frequency: 3200, gain: 0, q: 1.3, enabled: true, color: "#06b6d4" },
  { id: 6, name: "Presence", type: "peaking", frequency: 6500, gain: 0, q: 1.1, enabled: true, color: "#3b82f6" },
  { id: 7, name: "Air Shelf", type: "highshelf", frequency: 11000, gain: 0, q: 0.707, enabled: true, color: "#a855f7" },
  { id: 8, name: "High Cut", type: "lowpass", frequency: 19000, gain: 0, q: 0.707, enabled: true, color: "#ec4899" },
];

export const EQ_PRESETS: EqPreset[] = [
  {
    id: "flat",
    name: "Flat / Reset",
    description: "Neutral bypass baseline curve",
    bands: [
      { name: "Sub Cut", type: "highpass", frequency: 25, gain: 0, q: 0.707, enabled: true },
      { name: "Low Shelf", type: "lowshelf", frequency: 90, gain: 0, q: 0.707, enabled: true },
      { name: "Low Mid", type: "peaking", frequency: 280, gain: 0, q: 1.2, enabled: true },
      { name: "Body Mid", type: "peaking", frequency: 1000, gain: 0, q: 1.4, enabled: true },
      { name: "High Mid", type: "peaking", frequency: 3200, gain: 0, q: 1.3, enabled: true },
      { name: "Presence", type: "peaking", frequency: 6500, gain: 0, q: 1.1, enabled: true },
      { name: "Air Shelf", type: "highshelf", frequency: 11000, gain: 0, q: 0.707, enabled: true },
      { name: "High Cut", type: "lowpass", frequency: 19000, gain: 0, q: 0.707, enabled: true },
    ],
  },
  {
    id: "master_polish",
    name: "Master Polish & Sheen",
    description: "Tight sub-bass, clean mud removal, air boost",
    bands: [
      { name: "Sub Cut", type: "highpass", frequency: 30, gain: 0, q: 0.707, enabled: true },
      { name: "Low Shelf", type: "lowshelf", frequency: 85, gain: 1.5, q: 0.707, enabled: true },
      { name: "Low Mid", type: "peaking", frequency: 310, gain: -2.0, q: 1.6, enabled: true },
      { name: "Body Mid", type: "peaking", frequency: 1200, gain: -0.8, q: 1.8, enabled: true },
      { name: "High Mid", type: "peaking", frequency: 3500, gain: 1.2, q: 1.2, enabled: true },
      { name: "Presence", type: "peaking", frequency: 7200, gain: 1.8, q: 1.1, enabled: true },
      { name: "Air Shelf", type: "highshelf", frequency: 12000, gain: 2.5, q: 0.707, enabled: true },
      { name: "High Cut", type: "lowpass", frequency: 20000, gain: 0, q: 0.707, enabled: true },
    ],
  },
  {
    id: "vocal_clarity",
    name: "Vocal Clarity & Presence",
    description: "De-muds low end and boosts intelligibility / air",
    bands: [
      { name: "Sub Cut", type: "highpass", frequency: 80, gain: 0, q: 0.707, enabled: true },
      { name: "Low Shelf", type: "lowshelf", frequency: 160, gain: -1.5, q: 0.707, enabled: true },
      { name: "Low Mid", type: "peaking", frequency: 400, gain: -3.0, q: 2.0, enabled: true },
      { name: "Body Mid", type: "peaking", frequency: 1000, gain: 0.5, q: 1.4, enabled: true },
      { name: "High Mid", type: "peaking", frequency: 3800, gain: 2.8, q: 1.3, enabled: true },
      { name: "Presence", type: "peaking", frequency: 8500, gain: 2.0, q: 1.0, enabled: true },
      { name: "Air Shelf", type: "highshelf", frequency: 13000, gain: 3.2, q: 0.707, enabled: true },
      { name: "High Cut", type: "lowpass", frequency: 18500, gain: 0, q: 0.707, enabled: true },
    ],
  },
  {
    id: "warm_acoustic",
    name: "Warm & Rich Acoustic",
    description: "Silky top and full, natural wooden body without boom",
    bands: [
      { name: "Sub Cut", type: "highpass", frequency: 40, gain: 0, q: 0.707, enabled: true },
      { name: "Low Shelf", type: "lowshelf", frequency: 110, gain: 1.2, q: 0.707, enabled: true },
      { name: "Low Mid", type: "peaking", frequency: 220, gain: -2.2, q: 1.8, enabled: true },
      { name: "Body Mid", type: "peaking", frequency: 800, gain: 1.0, q: 1.2, enabled: true },
      { name: "High Mid", type: "peaking", frequency: 2800, gain: 1.5, q: 1.1, enabled: true },
      { name: "Presence", type: "peaking", frequency: 5500, gain: 0.8, q: 1.0, enabled: true },
      { name: "Air Shelf", type: "highshelf", frequency: 10500, gain: 1.8, q: 0.707, enabled: true },
      { name: "High Cut", type: "lowpass", frequency: 19500, gain: 0, q: 0.707, enabled: true },
    ],
  },
  {
    id: "punchy_drums",
    name: "Tight & Punchy Beat",
    description: "Punchy kick fundamental, snare snap, smooth cymbals",
    bands: [
      { name: "Sub Cut", type: "highpass", frequency: 32, gain: 0, q: 0.707, enabled: true },
      { name: "Low Shelf", type: "lowshelf", frequency: 65, gain: 3.0, q: 0.9, enabled: true },
      { name: "Low Mid", type: "peaking", frequency: 380, gain: -3.5, q: 2.2, enabled: true },
      { name: "Body Mid", type: "peaking", frequency: 1800, gain: 1.5, q: 1.5, enabled: true },
      { name: "High Mid", type: "peaking", frequency: 4500, gain: 2.5, q: 1.4, enabled: true },
      { name: "Presence", type: "peaking", frequency: 9000, gain: 1.2, q: 1.0, enabled: true },
      { name: "Air Shelf", type: "highshelf", frequency: 14000, gain: 1.5, q: 0.707, enabled: true },
      { name: "High Cut", type: "lowpass", frequency: 19000, gain: 0, q: 0.707, enabled: true },
    ],
  },
];
