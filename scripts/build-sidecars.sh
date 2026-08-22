#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANALYZER_DIR="$ROOT_DIR/analyzer"
BINARIES_DIR="$ROOT_DIR/src-tauri/binaries"

# Determine python / pyinstaller
if [ -f "$ROOT_DIR/venv/bin/pyinstaller" ]; then
    PYINSTALLER="$ROOT_DIR/venv/bin/pyinstaller"
elif [ -f "$ANALYZER_DIR/.venv/bin/pyinstaller" ]; then
    PYINSTALLER="$ANALYZER_DIR/.venv/bin/pyinstaller"
elif command -v pyinstaller &>/dev/null; then
    PYINSTALLER="pyinstaller"
else
    echo "Error: pyinstaller not found in venv or PATH. Run 'pip install pyinstaller' in your venv." >&2
    exit 1
fi

TRIPLE=$(rustc -Vv | sed -n 's/host: //p')
echo "Building sidecars for target: $TRIPLE"

mkdir -p "$BINARIES_DIR"

echo "Compiling analyzer..."
"$PYINSTALLER" --onefile "$ANALYZER_DIR/analyze.py" --name analyze \
    --collect-all numpy \
    --collect-all soundfile \
    --distpath "$ANALYZER_DIR/dist" --workpath "$ANALYZER_DIR/build" --specpath "$ANALYZER_DIR"

echo "Compiling transcriber..."
"$PYINSTALLER" --onefile "$ANALYZER_DIR/transcribe.py" --name transcribe \
    --collect-all demucs \
    --collect-all numpy \
    --collect-all soundfile \
    --collect-all faster_whisper \
    --collect-all ctranslate2 \
    --distpath "$ANALYZER_DIR/dist" --workpath "$ANALYZER_DIR/build" --specpath "$ANALYZER_DIR"

cp "$ANALYZER_DIR/dist/analyze" "$BINARIES_DIR/analyzer-$TRIPLE"
cp "$ANALYZER_DIR/dist/transcribe" "$BINARIES_DIR/transcriber-$TRIPLE"
chmod +x "$BINARIES_DIR/analyzer-$TRIPLE" "$BINARIES_DIR/transcriber-$TRIPLE"

echo "Sidecars successfully built and copied to $BINARIES_DIR:"
ls -lh "$BINARIES_DIR/analyzer-$TRIPLE" "$BINARIES_DIR/transcriber-$TRIPLE"
