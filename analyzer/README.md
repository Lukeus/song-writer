# Audio sidecars

Two Python sidecars, both invoked by the Rust backend
(`src-tauri/src/utilities/audio.rs`), each taking one audio file path and
printing a single JSON object to stdout:

- **`analyze.py`** → `bpm`, `key`, `duration_secs`, and a best-effort `chords`
  timeline.
- **`transcribe.py`** → `lyrics` (plain text), timestamped `segments`, and the
  detected `language`. Transcription runs **locally** via
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CPU, no GPU/torch).
  The Whisper model downloads and caches on first use, then runs offline. Set
  `SONGWRITER_WHISPER_MODEL` (e.g. `medium`) to trade speed for accuracy on dense
  mixes; the default is `small`.

## Develop / test standalone

```bash
cd analyzer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 analyze.py /path/to/track.wav
```

In **debug builds** the app calls each script directly with the project venv's
`python3` (falling back to system `python3`), so you can iterate without
packaging. `transcribe.py` needs `faster-whisper` installed in that venv.

> Note: `src-tauri/binaries/transcriber-<triple>` ships as a tiny placeholder
> script so `pnpm tauri dev` builds. Replace it with a real PyInstaller binary
> (below) before a release build.

## Package as Tauri sidecars (for release builds)

Tauri runs external binaries named per the current target triple. Build each as
a self-contained executable with PyInstaller and place it where Tauri expects:

```bash
cd analyzer
source .venv/bin/activate
pip install pyinstaller
pyinstaller --onefile analyze.py
pyinstaller --onefile transcribe.py

# Find your Rust host target triple:
TRIPLE=$(rustc -Vv | sed -n 's/host: //p')   # e.g. aarch64-apple-darwin

mkdir -p ../src-tauri/binaries
cp dist/analyze    ../src-tauri/binaries/analyzer-$TRIPLE
cp dist/transcribe ../src-tauri/binaries/transcriber-$TRIPLE
```

`src-tauri/tauri.conf.json` declares `bundle.externalBin: ["binaries/analyzer",
"binaries/transcriber"]`, so the matching `<name>-<triple>` binaries are bundled
and executed in release builds. Build one of each per platform you ship.
