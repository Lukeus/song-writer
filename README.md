# Song Writer

A macOS desktop app for songwriters. Write **lyrics with chords anchored above
syllables**, analyse and master your recordings, catalog your Logic Pro
projects, and work with a **local AI agent** that can actually read the song
you're writing.

Built with **Tauri 2** (Rust) + **React 19** + **TipTap 3** + **SQLite**.
Everything runs on your machine — the AI is local Ollama, transcription is local
Whisper. Nothing is uploaded.

## Stack

| Layer    | Tech |
|----------|------|
| Editor   | React + TipTap (custom inline `chord` node) |
| Backend  | Rust / Tauri commands |
| Storage  | SQLite via `rusqlite` (bundled) |
| AI       | Pluggable providers over HTTP; first is local Ollama |
| Audio    | Python sidecars — librosa, faster-whisper, Demucs, ffmpeg |
| Files    | `walkdir` scans for `.logicx` bundles |

## Features

**Chord editor.** Chords are zero-width inline nodes inserted immediately before
the syllable they sit over, so they travel with that syllable when the line
wraps. A suggestions bar offers the diatonic chords of the inferred key.

**Audio analysis.** Attach audio to a song (referenced in place, never copied)
and get BPM, musical key, duration, and a chord timeline.

**Lyric transcription.** Local Whisper turns a recording's vocals into
timestamped lyrics, optionally isolating the vocal stem with Demucs first.

**Mastering.** Measure LUFS, true peak, LRA, dynamics and tonal balance, get
recommendations, and render a mastered copy to a target loudness.

**AI agent.** A songwriting collaborator that is given the actual song — see
below.

**Logic Pro catalog.** Scan a directory for `.logicx` bundles and link each song
to the project it belongs to.

## The AI agent

The agent is the reason this isn't just a chat window next to an editor: it is
handed everything the app knows about the open song, rebuilt on every turn.

- The **lyrics as written**, with chords rendered inline as `[Bm]There is a
  [G]power` so chord placement survives into text
- **Tempo, key and duration** from the attached recording
- **The chords the recording leans on**, weighted by how long each is held
- Machine-transcribed lyrics, when nothing has been typed yet
- The linked Logic project

A "sees this song" toggle shows the exact context block being sent, so what the
agent can and cannot see is never a mystery.

### Placing chords

Because the agent reads chords in `[Bm]lyric` notation, it writes them back the
same way, and each marker becomes a real chord node anchored to the following
syllable — including mid-word, where the change usually falls:

```
There is a [Bm]power in the [G]people and the ways that they con[Em]nect.
```

Bracketed text that isn't a chord symbol (`[Chorus]`, `[Verse 2]`) stays as
plain text.

### Applying changes

When asked to rewrite or chord the song, the agent returns the complete new
version inside a fenced ` ```song ` block. Only that block is ever applied —
never the commentary around it — and it is shown in full on a card with
**Apply to song** / **Append instead**. There's an **Auto-apply** toggle if you
would rather rewrites land directly; `⌘Z` in the editor undoes them.

> Small local models drift. They will occasionally alter a word they were told
> to leave alone, which is why the proposal is shown before it is applied.
> Larger models (e.g. `gpt-oss:20b`) follow the format more reliably than 8B
> ones.

### Providers

Everything goes through one `Provider` trait, so adding a vendor means writing
one implementation and adding one arm to `build_provider` — no caller changes.
Ollama ships configured at `http://127.0.0.1:11434` and is seeded on first run.
Provider calls live in Rust rather than the webview: Ollama's CORS rejects the
Tauri origin, and future providers' API keys must never reach the frontend.

Any installed model works. Ones advertising `tools` are preferred by default
(the agent loop will need them); ones advertising `thinking` get a Reasoning
toggle, with the reasoning kept out of the answer.

## Architecture

```
src/                          React frontend
  api.ts                      typed wrappers over Tauri `invoke()`
  App.tsx                     3-pane shell: songs | editor | utilities
  components/
    PaneResizer.tsx           draggable, persisted pane widths
    UtilitiesPane.tsx         tabbed host for utilities
    Dashboard.tsx             library overview
  editor/
    ChordNode.ts              the custom TipTap inline chord node
    ChordEditor.tsx           editor + chord-insertion toolbar
    musicTheory.ts            key inference + diatonic chord suggestions
  utilities/                  self-contained feature panels
    registry.ts               register a utility here to add a tab
    ai/                       the agent panel
    audio/                    analysis, playback, mastering
    logic/                    Logic project linking

src-tauri/src/                Rust backend
  lib.rs                      app setup, DB init, command registration
  commands.rs                 song + Logic project commands
  db.rs                       SQLite schema + CRUD
  logic.rs                    .logicx bundle scanner
  ai/
    mod.rs                    Provider trait, streaming events, run registry
    ollama.rs                 the Ollama provider
    context.rs                song context builder + `[Bm]` notation parser
    commands.rs               AI Tauri commands
  utilities/
    audio.rs                  media files, analysis, transcription
    mastering.rs              loudness measurement and rendering

analyzer/                     Python sidecars (see analyzer/README.md)
```

### Adding a feature

Utilities are self-contained. Drop a module under `src/utilities/`, register it
in `registry.ts`, add its Rust commands under `src-tauri/src/utilities/`, and
list them in `lib.rs`. The rest of the shell is untouched.

### How chords stay anchored

A chord is a **zero-width inline node** inserted into the lyric flow right
before the syllable it sits over. Because it's a real node at a real document
position, it travels with that syllable when the line wraps. Its label renders
in an absolutely-positioned span lifted above the baseline (see
`editor/editor.css`), so lyrics never shift to make room.

### Data model

- `songs` — `title`, `content_json` (the TipTap doc), timestamps, nullable
  `logic_project_id`
- `media_files` — audio referenced by path, plus analysis (`bpm`, `musical_key`,
  `chords_json`) and transcription (`lyrics`, `lyrics_json`) columns
- `song_media` — many-to-many between songs and audio
- `logic_projects` — `name`, unique `path`, filesystem timestamps
- `ai_providers` / `ai_conversations` / `ai_messages` — configured endpoints and
  chat history. A conversation's `song_id` is null for library-wide threads

The DB lives at
`~/Library/Application Support/com.lukeusadams.song-writer/songwriter.db`.

## Develop

```bash
pnpm install
pnpm tauri dev
```

For audio analysis and transcription, set up the Python side once:

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r analyzer/requirements.txt
```

For the AI agent, have Ollama running with at least one model:

```bash
ollama serve
ollama pull llama3.2
```

## Test

```bash
cd src-tauri && cargo test
```

## Build a release `.app`

```bash
pnpm tauri build
```

> The sidecar binaries under `src-tauri/binaries/` are committed as small
> placeholder scripts — enough for `pnpm tauri dev` to build, since debug builds
> call the Python scripts directly. Real PyInstaller sidecars are ~77 MB each
> and are **not** committed; build them before a release. See
> [analyzer/README.md](analyzer/README.md).

## Requirements

- Rust ≥ 1.88 (`brew upgrade rust`)
- Node 20+ / pnpm
- Xcode Command Line Tools
- ffmpeg (mastering) — `brew install ffmpeg`
- Python 3.11+ (audio sidecars)
- [Ollama](https://ollama.com) (AI agent) — optional
