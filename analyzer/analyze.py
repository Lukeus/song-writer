#!/usr/bin/env python3
"""Audio analyzer for song-writer.

Takes one audio file path and prints a single JSON object to stdout describing
the track's tempo, key, duration, and a best-effort chord timeline:

    {
      "bpm": 122.0,
      "key": "A minor",
      "duration_secs": 211.3,
      "chords": [ { "time": 0.0, "label": "Am" }, { "time": 2.1, "label": "F" } ]
    }

On failure it prints `{"error": "..."}` and exits non-zero. The Rust side reads
stdout and stores the result against the media file.

Chord/key detection here is heuristic (chroma templates + Krumhansl-Schmuckler)
and is intended as a useful approximation, not a transcription.
"""

import json
import multiprocessing
import sys

# Pitch-class names, index 0 == C.
PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles (major / minor), rotated per tonic.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def fail(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(1)


def estimate_key(chroma_mean):
    """Return a human-readable key like 'A minor' via profile correlation."""
    import numpy as np

    def best(profile):
        scores = []
        for tonic in range(12):
            rotated = np.roll(profile, tonic)
            # Pearson correlation between mean chroma and rotated profile.
            c = np.corrcoef(chroma_mean, rotated)[0, 1]
            scores.append(c if not np.isnan(c) else -1.0)
        idx = int(np.argmax(scores))
        return idx, scores[idx]

    maj_idx, maj_score = best(MAJOR_PROFILE)
    min_idx, min_score = best(MINOR_PROFILE)
    if maj_score >= min_score:
        return f"{PITCHES[maj_idx]} major"
    return f"{PITCHES[min_idx]} minor"


def estimate_chords(chroma, beat_times, sr, hop_length):
    """Label each beat segment with its best major/minor triad match."""
    import numpy as np

    # Triad templates (root, +major third / +minor third, +fifth).
    templates = {}
    for root in range(12):
        maj = np.zeros(12)
        for off in (0, 4, 7):
            maj[(root + off) % 12] = 1.0
        templates[PITCHES[root]] = maj
        minor = np.zeros(12)
        for off in (0, 3, 7):
            minor[(root + off) % 12] = 1.0
        templates[f"{PITCHES[root]}m"] = minor

    frame_for = lambda t: int(t * sr / hop_length)
    chords = []
    bounds = list(beat_times) + [None]
    last_label = None
    for i in range(len(beat_times)):
        start = frame_for(bounds[i])
        end = frame_for(bounds[i + 1]) if bounds[i + 1] is not None else chroma.shape[1]
        if end <= start:
            continue
        seg = chroma[:, start:end].mean(axis=1)
        if seg.sum() <= 0:
            continue
        seg = seg / (np.linalg.norm(seg) + 1e-9)
        label = max(templates.items(), key=lambda kv: float(np.dot(seg, kv[1])))[0]
        # Collapse consecutive identical labels into one entry.
        if label != last_label:
            chords.append({"time": round(float(bounds[i]), 2), "label": label})
            last_label = label
    return chords


def compute_fingerprint(chroma, sr, hop_length):
    """Generate compact acoustic chroma hash sequence (12-bit bitmask per 0.5s frame)."""
    import numpy as np

    # Frame window: ~0.5 seconds per hash
    frames_per_window = max(1, int((sr / hop_length) * 0.5))
    hashes = []
    num_frames = chroma.shape[1]

    for start in range(0, num_frames, frames_per_window):
        end = min(start + frames_per_window, num_frames)
        if end <= start:
            continue
        chunk = chroma[:, start:end].mean(axis=1)
        med = float(np.median(chunk))
        val = 0
        for i in range(12):
            if chunk[i] > med:
                val |= (1 << i)
        hashes.append(val)

    return hashes


def main() -> None:
    if len(sys.argv) < 2:
        fail("usage: analyze.py <audio-file>")

    path = sys.argv[1]

    try:
        import numpy as np  # noqa: F401  (used by helpers)
        import librosa
    except ImportError as e:
        fail(f"missing dependency: {e}. Run: pip install -r requirements.txt")

    try:
        y, sr = librosa.load(path, mono=True)
    except Exception as e:  # noqa: BLE001
        fail(f"could not load audio: {e}")

    duration = float(librosa.get_duration(y=y, sr=sr))

    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    # Newer librosa returns `tempo` as a numpy array; coerce to a scalar.
    tempo_val = float(np.atleast_1d(tempo)[0])
    bpm = tempo_val if tempo_val > 0 else None

    hop_length = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    chroma_mean = chroma.mean(axis=1)

    key = estimate_key(chroma_mean)
    beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=512)
    chords = estimate_chords(chroma, beat_times, sr, hop_length)
    fingerprint = compute_fingerprint(chroma, sr, hop_length)

    print(
        json.dumps(
            {
                "bpm": round(bpm, 1) if bpm else None,
                "key": key,
                "duration_secs": round(duration, 2),
                "chords": chords,
                "fingerprint": fingerprint,
            }
        )
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
