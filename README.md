# Song Writer

A macOS desktop app for songwriters: write **lyrics with chords anchored above
syllables**, and **catalog your local Logic Pro projects** — linking each song to
the `.logicx` it belongs to.

Built with **Tauri 2** (Rust backend) + **React 19** + **TipTap 3** + **SQLite**.

## Stack

| Layer    | Tech |
|----------|------|
| Editor   | React + TipTap (custom inline `chord` node) |
| Backend  | Rust / Tauri commands |
| Storage  | SQLite via `rusqlite` (bundled) |
| Files    | `walkdir` scans for `.logicx` bundles |

## Architecture

```
src/                         React frontend
  api.ts                     typed wrappers over Tauri `invoke()`
  App.tsx                    3-pane shell: songs | editor | projects
  editor/
    ChordNode.ts             the custom TipTap inline chord node
    ChordEditor.tsx          editor + chord-insertion toolbar
    editor.css               chord-above-lyric positioning
  LogicProjectsPanel.tsx     scan / list / link / reveal Logic projects

src-tauri/src/               Rust backend
  lib.rs                     app setup, DB init, command registration
  commands.rs                #[tauri::command] bridge functions
  db.rs                      SQLite schema + CRUD (songs, logic_projects)
  logic.rs                   .logicx bundle scanner (+ unit test)
```

### How chords stay anchored
A chord is a **zero-width inline node** inserted into the lyric flow right before
the syllable it sits over. Because it's a real node at a real document position,
it travels with that syllable when the line wraps. Its label is rendered in an
absolutely-positioned span lifted above the baseline (see `editor/editor.css`).

### Data model
- `songs` — `title`, `content_json` (the TipTap doc), timestamps, and a nullable
  `logic_project_id`.
- `logic_projects` — `name`, unique `path`, filesystem `created_at` / `modified_at`,
  `last_scanned_at`. Re-scanning upserts by path.
- A song links to at most one project (`ON DELETE SET NULL`).

The DB lives at
`~/Library/Application Support/com.lukeusadams.song-writer/songwriter.db`.

## Develop

```bash
pnpm install
pnpm tauri dev      # launches the desktop app with hot reload
```

## Build a release `.app`

```bash
pnpm tauri build
```

## Test the scanner

```bash
cd src-tauri && cargo test
```

## Requirements
- Rust ≥ 1.88 (some transitive deps now require it; `brew upgrade rust`)
- Node 20+ / pnpm
- Xcode Command Line Tools
