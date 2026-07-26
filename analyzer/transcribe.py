#!/usr/bin/env python3
"""Lyric transcriber for song-writer.

Takes one audio file path and prints a single JSON object to stdout describing
the transcribed vocals:

    {
      "language": "en",
      "lyrics": "line one\nline two\n...",
      "segments": [ { "start": 12.3, "end": 15.1, "text": "line one" } ],
      "vocals_isolated": true
    }

On failure it prints `{"error": "..."}` and exits non-zero. The Rust side reads
stdout and stores the result against the media file.

Transcription runs **locally** via faster-whisper (CTranslate2). The model is
downloaded and cached on first use (under ~/.cache/huggingface); after that it
runs fully offline. The result is a best-effort transcription of sung vocals,
not a definitive lyric sheet — busy mixes and heavy effects reduce accuracy.

With `--isolate`, Demucs first separates the mix and we transcribe only the
isolated **vocals** stem. This markedly improves lyric accuracy on full mixes at
the cost of a slow, memory-heavy separation pass (Demucs pulls in PyTorch and
downloads its model on first use).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

# Model size trades accuracy for speed/memory. Override with the env var, e.g.
# SONGWRITER_WHISPER_MODEL=medium for better lyrics on dense mixes.
DEFAULT_MODEL = os.environ.get("SONGWRITER_WHISPER_MODEL", "small")
# Demucs model used for vocal isolation. htdemucs is the current 4-stem default.
DEMUCS_MODEL = os.environ.get("SONGWRITER_DEMUCS_MODEL", "htdemucs")


def fail(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(1)


def isolate_vocals(path: str, out_dir: str) -> str:
    """Separate `path` with Demucs and write the vocals stem into `out_dir`.

    Returns the path to the written vocals WAV. Raises on any failure so the
    caller can report it (isolation was explicitly requested).

    Uses Demucs's lower-level API (`get_model` / `apply_model`) rather than
    `demucs.api`, which is not present in the released 4.0.1 PyPI wheel. The
    normalization mirrors `demucs.separate` so results match the CLI.
    """
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile
        from demucs.pretrained import get_model
    except ImportError as e:
        raise RuntimeError(
            f"vocal isolation needs Demucs ({e}). Run: pip install -r requirements.txt"
        )

    # Demucs runs on CPU here; it is slow but needs no GPU.
    model = get_model(DEMUCS_MODEL)
    model.eval()
    if "vocals" not in model.sources:
        raise RuntimeError(f"model '{DEMUCS_MODEL}' has no 'vocals' stem")

    wav = AudioFile(path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)

    with torch.no_grad():
        sources = apply_model(model, wav[None], device="cpu", progress=False)[0]
    sources = sources * ref.std() + ref.mean()

    vocals = sources[model.sources.index("vocals")]
    # Write with soundfile (already a dependency) rather than demucs's
    # save_audio, which routes through a torchaudio backend that now requires
    # torchcodec. soundfile wants (frames, channels); the stem is (channels, time).
    data = vocals.t().cpu().numpy()
    np.clip(data, -1.0, 1.0, out=data)
    out_path = os.path.join(out_dir, "vocals.wav")
    sf.write(out_path, data, model.samplerate, subtype="PCM_16")
    return out_path


def transcribe(audio_path: str, model_name: str) -> tuple[str, list, str | None]:
    """Run faster-whisper on `audio_path`, returning (lyrics, segments, language)."""
    from faster_whisper import WhisperModel

    # int8 on CPU keeps memory/CPU modest and needs no GPU. A VAD filter skips
    # long instrumental stretches so they don't hallucinate lyrics.
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, vad_filter=True)

    seg_list = []
    lines = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        seg_list.append(
            {
                "start": round(float(seg.start), 2),
                "end": round(float(seg.end), 2),
                "text": text,
            }
        )
        lines.append(text)
    return "\n".join(lines), seg_list, getattr(info, "language", None)


def main() -> None:
    args = sys.argv[1:]
    isolate = "--isolate" in args
    positional = [a for a in args if not a.startswith("--")]
    if not positional:
        fail("usage: transcribe.py <audio-file> [model] [--isolate]")

    path = positional[0]
    model_name = positional[1] if len(positional) > 1 else DEFAULT_MODEL

    if not os.path.isfile(path):
        fail(f"not a file: {path}")

    try:
        from faster_whisper import WhisperModel  # noqa: F401  (imported in transcribe())
    except ImportError as e:
        fail(f"missing dependency: {e}. Run: pip install -r requirements.txt")

    # Isolate vocals into a temp dir first when requested; transcription must
    # happen before the dir (and the stem) is cleaned up.
    with tempfile.TemporaryDirectory() as tmp:
        audio_for_asr = path
        if isolate:
            try:
                audio_for_asr = isolate_vocals(path, tmp)
            except Exception as e:  # noqa: BLE001
                fail(f"vocal isolation failed: {e}")

        try:
            lyrics, segments, language = transcribe(audio_for_asr, model_name)
        except Exception as e:  # noqa: BLE001
            fail(f"transcription failed: {e}")

    print(
        json.dumps(
            {
                "language": language,
                "lyrics": lyrics,
                "segments": segments,
                "vocals_isolated": isolate,
            }
        )
    )


if __name__ == "__main__":
    main()
