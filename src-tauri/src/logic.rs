//! Scans a directory for Logic Pro project bundles (`.logicx`) and extracts
//! lightweight metadata from the filesystem.
//!
//! A `.logicx` is a macOS *bundle* — i.e. a directory that Finder presents as a
//! single file. We therefore look for directory entries whose name ends in
//! `.logicx`, record them, and do **not** descend into them. Rich musical
//! metadata (tempo, key, track count) lives in binary plists inside the bundle
//! and is intentionally out of scope for this first pass.

use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

/// Metadata for a single Logic Pro project, as surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LogicProject {
    /// Project name, derived from the bundle's file name (without `.logicx`).
    pub name: String,
    /// Absolute path to the `.logicx` bundle.
    pub path: String,
    /// Filesystem creation date, RFC 3339, if the OS provides it.
    pub created_at: Option<String>,
    /// Filesystem last-modified date, RFC 3339.
    pub modified_at: Option<String>,
}

fn system_time_to_rfc3339(t: SystemTime) -> String {
    let dt: DateTime<Utc> = t.into();
    dt.to_rfc3339()
}

/// Walk `root` recursively and return every `.logicx` bundle found.
///
/// Symlinks are not followed, and we never descend into a project bundle.
pub fn scan_logic_projects(root: &Path) -> Result<Vec<LogicProject>, String> {
    if !root.exists() {
        return Err(format!("Path does not exist: {}", root.display()));
    }

    let mut projects = Vec::new();

    // Drive the iterator manually so that when we hit a `.logicx` bundle we can
    // record it and then call `skip_current_dir()` — yielding the bundle but
    // never traversing the (potentially thousands of) files inside it.
    let mut it = WalkDir::new(root).follow_links(false).into_iter();
    while let Some(next) = it.next() {
        let entry = match next {
            Ok(e) => e,
            Err(_) => continue, // permission denied, broken symlink, etc.
        };

        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".logicx") {
            continue;
        }

        // Don't walk into the bundle's internals.
        if entry.file_type().is_dir() {
            it.skip_current_dir();
        }

        let Ok(meta) = entry.metadata() else { continue };

        projects.push(LogicProject {
            name: name.trim_end_matches(".logicx").to_string(),
            path: entry.path().to_string_lossy().to_string(),
            created_at: meta.created().ok().map(system_time_to_rfc3339),
            modified_at: meta.modified().ok().map(system_time_to_rfc3339),
        });
    }

    // Most-recently-modified first — the usual "what was I just working on" order.
    projects.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(projects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finds_bundles_without_descending_into_them() {
        // Lay out a temp tree:
        //   root/
        //     Song A.logicx/            <- bundle (a directory)
        //       Alternatives/Inner.logicx/   <- decoy nested inside a bundle
        //     nested/Song B.logicx/     <- bundle in a subdirectory
        //     notes.txt                 <- ignored
        let root = std::env::temp_dir().join(format!("sw_logic_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Song A.logicx/Alternatives/Inner.logicx")).unwrap();
        fs::create_dir_all(root.join("nested/Song B.logicx")).unwrap();
        fs::write(root.join("notes.txt"), "hi").unwrap();

        let found = scan_logic_projects(&root).unwrap();
        let names: Vec<_> = found.iter().map(|p| p.name.as_str()).collect();

        // Both top-level bundles are found...
        assert!(names.contains(&"Song A"), "got {names:?}");
        assert!(names.contains(&"Song B"), "got {names:?}");
        // ...but the bundle nested *inside* Song A must NOT be returned.
        assert!(!names.contains(&"Inner"), "should not descend into a bundle: {names:?}");
        assert_eq!(found.len(), 2, "exactly two bundles expected: {names:?}");

        let _ = fs::remove_dir_all(&root);
    }
}
