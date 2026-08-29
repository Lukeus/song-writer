import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaFile } from "../api";
import {
  DEFAULT_EQ_BANDS,
  type ActiveAudioSource,
  type EqBand,
  type EqPreset,
  type GlobalAudioState,
} from "./types";

const GlobalAudioCtx = createContext<GlobalAudioState | null>(null);

export function useGlobalAudio() {
  const ctx = useContext(GlobalAudioCtx);
  if (!ctx) {
    throw new Error("useGlobalAudio must be used within a GlobalAudioProvider");
  }
  return ctx;
}

export function GlobalAudioProvider({ children }: { children: React.ReactNode }) {
  const [primaryTrack, setPrimaryTrack] = useState<MediaFile | null>(null);
  const [referenceTrack, setReferenceTrack] = useState<MediaFile | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveAudioSource>("primary");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const [isEqBypassed, setIsEqBypassed] = useState(false);
  const [eqBands, setEqBandsState] = useState<EqBand[]>(DEFAULT_EQ_BANDS);
  const [refVolumeOffset, setRefVolumeOffsetState] = useState(0); // dB
  const [syncPlayheads, setSyncPlayheadsState] = useState(true);
  const [loop, setLoopState] = useState(false);

  // Audio HTML elements and Web Audio Nodes
  const primaryAudioRef = useRef<HTMLAudioElement | null>(null);
  const refAudioRef = useRef<HTMLAudioElement | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const primarySourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const refSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);

  const filterNodesRef = useRef<BiquadFilterNode[]>([]);
  const primaryGainNodeRef = useRef<GainNode | null>(null);
  const refGainNodeRef = useRef<GainNode | null>(null);
  const masterGainNodeRef = useRef<GainNode | null>(null);

  const primaryAnalyserRef = useRef<AnalyserNode | null>(null);
  const refAnalyserRef = useRef<AnalyserNode | null>(null);

  // Helper to ensure Web Audio graph is constructed
  const ensureAudioGraph = useCallback(() => {
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {});
      }
      return audioCtxRef.current;
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextClass();
    audioCtxRef.current = ctx;

    // Create 8 Biquad Filter Nodes
    const filters: BiquadFilterNode[] = eqBands.map((band) => {
      const node = ctx.createBiquadFilter();
      node.type = band.type;
      node.frequency.value = band.frequency;
      if (band.type !== "lowshelf" && band.type !== "highshelf") {
        node.Q.value = band.q;
      }
      if (band.type !== "highpass" && band.type !== "lowpass") {
        node.gain.value = band.gain;
      }
      return node;
    });
    filterNodesRef.current = filters;

    // Connect filters in series: filter[0] -> filter[1] -> ... -> filter[7]
    for (let i = 0; i < filters.length - 1; i++) {
      filters[i].connect(filters[i + 1]);
    }

    // Analyser nodes (FFT 2048 for high frequency resolution)
    const primAnalyser = ctx.createAnalyser();
    primAnalyser.fftSize = 2048;
    primAnalyser.smoothingTimeConstant = 0.82;
    primaryAnalyserRef.current = primAnalyser;

    const rAnalyser = ctx.createAnalyser();
    rAnalyser.fftSize = 2048;
    rAnalyser.smoothingTimeConstant = 0.82;
    refAnalyserRef.current = rAnalyser;

    // Primary & Ref Gain Nodes (for A/B switching and level matching)
    const primGain = ctx.createGain();
    const rGain = ctx.createGain();
    const mGain = ctx.createGain();
    mGain.gain.value = volume;

    const refGainMultiplier = Math.pow(10, refVolumeOffset / 20);
    primGain.gain.value = activeSource === "primary" ? 1.0 : 0.0;
    rGain.gain.value = activeSource === "reference" ? refGainMultiplier : 0.0;

    primaryGainNodeRef.current = primGain;
    refGainNodeRef.current = rGain;
    masterGainNodeRef.current = mGain;

    // Wire up filter chain to primary gain -> analyser -> master gain
    if (filters.length > 0) {
      filters[filters.length - 1].connect(primGain);
    }
    primGain.connect(primAnalyser);
    primAnalyser.connect(mGain);

    // Wire up ref audio chain: refGain -> refAnalyser -> master gain
    rGain.connect(rAnalyser);
    rAnalyser.connect(mGain);

    // Master gain to destination
    mGain.connect(ctx.destination);

    // Wire HTML audio elements to Web Audio nodes if elements exist
    if (primaryAudioRef.current && !primarySourceNodeRef.current) {
      try {
        const srcNode = ctx.createMediaElementSource(primaryAudioRef.current);
        primarySourceNodeRef.current = srcNode;
        srcNode.connect(filters[0]);
      } catch (err) {
        console.warn("Could not create primary MediaElementSourceNode:", err);
      }
    }

    if (refAudioRef.current && !refSourceNodeRef.current) {
      try {
        const srcNode = ctx.createMediaElementSource(refAudioRef.current);
        refSourceNodeRef.current = srcNode;
        srcNode.connect(rGain);
      } catch (err) {
        console.warn("Could not create reference MediaElementSourceNode:", err);
      }
    }

    // Apply current eqBands and bypass state to the freshly created filter nodes
    const now = ctx.currentTime;
    eqBands.forEach((band, index) => {
      const node = filters[index];
      if (!node) return;
      node.type = band.type;
      if (isEqBypassed || !band.enabled) {
        if (band.type === "highpass") {
          node.frequency.setValueAtTime(10, now);
        } else if (band.type === "lowpass") {
          node.frequency.setValueAtTime(22000, now);
        } else {
          node.gain.setValueAtTime(0, now);
          node.frequency.setValueAtTime(band.frequency, now);
        }
      } else {
        const freq = Math.max(20, Math.min(20000, band.frequency));
        const gain = Math.max(-24, Math.min(24, band.gain));
        const q = Math.max(0.1, Math.min(20, band.q));

        node.frequency.setValueAtTime(freq, now);
        if (band.type !== "highpass" && band.type !== "lowpass") {
          node.gain.setValueAtTime(gain, now);
        }
        if (band.type !== "lowshelf" && band.type !== "highshelf") {
          node.Q.setValueAtTime(q, now);
        }
      }
    });

    return ctx;
  }, [volume, eqBands, isEqBypassed, activeSource, refVolumeOffset]);

  // Sync Biquad Filter Parameters to eqBands state
  const syncBiquadFilters = useCallback(
    (bands: EqBand[], bypassed: boolean) => {
      const ctx = audioCtxRef.current;
      const filters = filterNodesRef.current;
      if (!ctx || filters.length === 0) return;

      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;
      bands.forEach((band, index) => {
        const node = filters[index];
        if (!node) return;

        node.type = band.type;

        if (bypassed || !band.enabled) {
          if (band.type === "highpass") {
            node.frequency.cancelScheduledValues(now);
            node.frequency.setValueAtTime(10, now);
          } else if (band.type === "lowpass") {
            node.frequency.cancelScheduledValues(now);
            node.frequency.setValueAtTime(22000, now);
          } else {
            node.gain.cancelScheduledValues(now);
            node.gain.setValueAtTime(0, now);
            node.frequency.cancelScheduledValues(now);
            node.frequency.setValueAtTime(band.frequency, now);
          }
        } else {
          const freq = Math.max(20, Math.min(20000, band.frequency));
          const gain = Math.max(-24, Math.min(24, band.gain));
          const q = Math.max(0.1, Math.min(20, band.q));

          node.frequency.cancelScheduledValues(now);
          node.frequency.setValueAtTime(freq, now);

          if (band.type !== "highpass" && band.type !== "lowpass") {
            node.gain.cancelScheduledValues(now);
            node.gain.setValueAtTime(gain, now);
          }
          if (band.type !== "lowshelf" && band.type !== "highshelf") {
            node.Q.cancelScheduledValues(now);
            node.Q.setValueAtTime(q, now);
          }
        }
      });
    },
    []
  );

  // Update filters whenever eqBands or isEqBypassed changes
  useEffect(() => {
    syncBiquadFilters(eqBands, isEqBypassed);
  }, [eqBands, isEqBypassed, syncBiquadFilters]);

  // Manage A/B Gain states and level matching
  useEffect(() => {
    const ctx = audioCtxRef.current;
    const primGain = primaryGainNodeRef.current;
    const rGain = refGainNodeRef.current;
    if (!ctx || !primGain || !rGain) return;

    const now = ctx.currentTime;
    const refGainMultiplier = Math.pow(10, refVolumeOffset / 20);

    if (activeSource === "primary") {
      primGain.gain.setTargetAtTime(1.0, now, 0.015);
      rGain.gain.setTargetAtTime(0.0, now, 0.015);
    } else {
      primGain.gain.setTargetAtTime(0.0, now, 0.015);
      rGain.gain.setTargetAtTime(refGainMultiplier, now, 0.015);
    }
  }, [activeSource, refVolumeOffset]);

  // Manage Master Volume and Mute
  useEffect(() => {
    const ctx = audioCtxRef.current;
    const mGain = masterGainNodeRef.current;
    if (!ctx || !mGain) return;

    const targetVal = isMuted ? 0 : volume;
    mGain.gain.setTargetAtTime(targetVal, ctx.currentTime, 0.01);
  }, [volume, isMuted]);

  // Connect Audio Elements once mounted
  useEffect(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    if (primaryAudioRef.current && !primarySourceNodeRef.current) {
      try {
        const srcNode = ctx.createMediaElementSource(primaryAudioRef.current);
        primarySourceNodeRef.current = srcNode;
        if (filterNodesRef.current.length > 0) {
          srcNode.connect(filterNodesRef.current[0]);
        }
      } catch (err) {
        console.warn("Error attaching primary audio source:", err);
      }
    }

    if (refAudioRef.current && !refSourceNodeRef.current && refGainNodeRef.current) {
      try {
        const srcNode = ctx.createMediaElementSource(refAudioRef.current);
        refSourceNodeRef.current = srcNode;
        srcNode.connect(refGainNodeRef.current);
      } catch (err) {
        console.warn("Error attaching ref audio source:", err);
      }
    }
  }, [primaryTrack, referenceTrack]);

  // Transport Control Actions
  const playTrack = useCallback(
    (track: MediaFile) => {
      ensureAudioGraph();
      setPrimaryTrack(track);
      setActiveSource("primary");
      setTimeout(() => {
        const el = primaryAudioRef.current;
        if (el) {
          el.play()
            .then(() => setIsPlaying(true))
            .catch(() => setIsPlaying(false));
        }
      }, 50);
    },
    [ensureAudioGraph]
  );

  const togglePlay = useCallback(() => {
    ensureAudioGraph();
    const primEl = primaryAudioRef.current;
    const refEl = refAudioRef.current;

    if (isPlaying) {
      primEl?.pause();
      refEl?.pause();
      setIsPlaying(false);
    } else {
      if (activeSource === "primary" || syncPlayheads) {
        primEl?.play().catch(() => {});
      }
      if (referenceTrack && (activeSource === "reference" || syncPlayheads)) {
        if (refEl && primEl && syncPlayheads) {
          refEl.currentTime = primEl.currentTime;
        }
        refEl?.play().catch(() => {});
      }
      setIsPlaying(true);
    }
  }, [ensureAudioGraph, isPlaying, activeSource, syncPlayheads, referenceTrack]);

  const pause = useCallback(() => {
    primaryAudioRef.current?.pause();
    refAudioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const seek = useCallback(
    (timeInSecs: number) => {
      const primEl = primaryAudioRef.current;
      const refEl = refAudioRef.current;
      const target = Math.max(0, Math.min(duration || 999999, timeInSecs));

      if (primEl) {
        primEl.currentTime = target;
      }
      if (refEl && syncPlayheads) {
        refEl.currentTime = target;
      }
      setCurrentTime(target);
    },
    [duration, syncPlayheads]
  );

  const setVolume = useCallback((vol: number) => {
    const clamped = Math.max(0, Math.min(1, vol));
    setVolumeState(clamped);
    if (clamped > 0) setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const toggleEqBypass = useCallback(() => {
    ensureAudioGraph();
    setIsEqBypassed((prev) => !prev);
  }, [ensureAudioGraph]);

  const updateEqBand = useCallback((id: number, updates: Partial<EqBand>) => {
    ensureAudioGraph();
    setEqBandsState((prev) =>
      prev.map((band) => (band.id === id ? { ...band, ...updates } : band))
    );
  }, [ensureAudioGraph]);

  const setEqBands = useCallback((bands: EqBand[]) => {
    ensureAudioGraph();
    setEqBandsState(bands);
  }, [ensureAudioGraph]);

  const applyPreset = useCallback((preset: EqPreset) => {
    ensureAudioGraph();
    setEqBandsState((prev) =>
      prev.map((b, i) => {
        const presetBand = preset.bands[i];
        if (!presetBand) return b;
        return {
          ...b,
          frequency: presetBand.frequency,
          gain: presetBand.gain,
          q: presetBand.q,
          type: presetBand.type,
          enabled: presetBand.enabled,
        };
      })
    );
  }, [ensureAudioGraph]);

  const resetEq = useCallback(() => {
    ensureAudioGraph();
    setEqBandsState(DEFAULT_EQ_BANDS);
    setIsEqBypassed(false);
  }, [ensureAudioGraph]);

  const setRefVolumeOffset = useCallback((offsetDb: number) => {
    setRefVolumeOffsetState(offsetDb);
  }, []);

  const setSyncPlayheads = useCallback((sync: boolean) => {
    setSyncPlayheadsState(sync);
  }, []);

  const setLoop = useCallback((l: boolean) => {
    setLoopState(l);
  }, []);

  const handleActiveSourceChange = useCallback(
    (source: ActiveAudioSource) => {
      ensureAudioGraph();
      setActiveSource(source);

      // Align ref track time if syncing
      if (syncPlayheads && primaryAudioRef.current && refAudioRef.current) {
        if (source === "reference") {
          refAudioRef.current.currentTime = primaryAudioRef.current.currentTime;
        } else {
          primaryAudioRef.current.currentTime = refAudioRef.current.currentTime;
        }
      }

      if (isPlaying) {
        if (source === "primary") {
          primaryAudioRef.current?.play().catch(() => {});
          if (!syncPlayheads) refAudioRef.current?.pause();
        } else {
          refAudioRef.current?.play().catch(() => {});
          if (!syncPlayheads) primaryAudioRef.current?.pause();
        }
      }
    },
    [ensureAudioGraph, syncPlayheads, isPlaying]
  );

  const primarySrc = primaryTrack ? convertFileSrc(primaryTrack.path) : undefined;
  const refSrc = referenceTrack ? convertFileSrc(referenceTrack.path) : undefined;

  const value: GlobalAudioState = {
    primaryTrack,
    referenceTrack,
    activeSource,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isEqBypassed,
    eqBands,
    isComparing: Boolean(referenceTrack),
    refVolumeOffset,
    syncPlayheads,
    loop,
    getPrimaryAnalyser: () => primaryAnalyserRef.current,
    getRefAnalyser: () => refAnalyserRef.current,
    getAudioContext: () => audioCtxRef.current,
    getBiquadFilterNodes: () => filterNodesRef.current,
    playTrack,
    setReferenceTrack,
    setActiveSource: handleActiveSourceChange,
    togglePlay,
    pause,
    seek,
    setVolume,
    toggleMute,
    toggleEqBypass,
    updateEqBand,
    setEqBands,
    applyPreset,
    resetEq,
    setRefVolumeOffset,
    setSyncPlayheads,
    setLoop,
  };

  return (
    <GlobalAudioCtx.Provider value={value}>
      {children}

      {/* Hidden audio elements routed via Web Audio API */}
      <audio
        ref={primaryAudioRef}
        src={primarySrc}
        preload="auto"
        crossOrigin="anonymous"
        loop={loop}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          if (activeSource === "primary" && !syncPlayheads) {
            setIsPlaying(false);
          }
        }}
        onTimeUpdate={(e) => {
          if (activeSource === "primary") {
            setCurrentTime(e.currentTarget.currentTime);
          }
        }}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || primaryTrack?.duration_secs || 0);
        }}
        onEnded={() => {
          if (!loop) {
            setIsPlaying(false);
            setCurrentTime(0);
          }
        }}
      />

      <audio
        ref={refAudioRef}
        src={refSrc}
        preload="auto"
        crossOrigin="anonymous"
        loop={loop}
        onPlay={() => {
          if (activeSource === "reference") setIsPlaying(true);
        }}
        onPause={() => {
          if (activeSource === "reference" && !syncPlayheads) {
            setIsPlaying(false);
          }
        }}
        onTimeUpdate={(e) => {
          if (activeSource === "reference") {
            setCurrentTime(e.currentTarget.currentTime);
          }
        }}
        onEnded={() => {
          if (!loop && activeSource === "reference") {
            setIsPlaying(false);
            setCurrentTime(0);
          }
        }}
      />
    </GlobalAudioCtx.Provider>
  );
}
