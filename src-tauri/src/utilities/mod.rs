//! Utilities — self-contained feature modules.
//!
//! Each utility owns a Rust module here (its Tauri commands) and a matching
//! React panel under `src/utilities/`. Adding a feature means dropping in a new
//! module and registering its commands in `lib.rs`; the rest of the app shell is
//! untouched. The first utility is [`audio`] (audio analysis + media files).

pub mod audio;
pub mod mastering;
