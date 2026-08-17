use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use walkdir::WalkDir;

use crate::hashing::hash_content;
use crate::watcher::ExcludeRules;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScannedFile {
    /// Forward-slash vault-relative path, matching the wire format the
    /// server's `relativePathSchema` expects regardless of host OS.
    pub relative_path: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScanSkip {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    /// Files that looked like Markdown but could not be read — e.g. not
    /// valid UTF-8. Reported rather than silently dropped, so a bad file
    /// shows up in the tray's error list instead of vanishing.
    pub skipped: Vec<ScanSkip>,
}

fn to_relative_slash_path(vault_root: &Path, absolute: &Path) -> Option<String> {
    let relative = absolute.strip_prefix(vault_root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn format_system_time(time: std::time::SystemTime) -> String {
    OffsetDateTime::from(time)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Walks the whole vault once, applying the exclusion rules and the
/// Markdown-only filter, and hashes every file it keeps. Used both for the
/// initial sync and as the local half of the periodic reconciliation scan.
pub fn scan_vault(vault_root: &Path, rules: &ExcludeRules) -> std::io::Result<ScanResult> {
    let mut result = ScanResult::default();

    for entry in WalkDir::new(vault_root).into_iter().filter_map(|entry| entry.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }

        let Some(relative_path) = to_relative_slash_path(vault_root, entry.path()) else {
            continue;
        };
        if rules.is_excluded(&relative_path) || !ExcludeRules::is_markdown(&relative_path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                result.skipped.push(ScanSkip {
                    relative_path,
                    reason: format!("could not read file metadata: {error}"),
                });
                continue;
            }
        };

        let bytes = match std::fs::read(entry.path()) {
            Ok(bytes) => bytes,
            Err(error) => {
                result.skipped.push(ScanSkip {
                    relative_path,
                    reason: format!("could not read file: {error}"),
                });
                continue;
            }
        };
        let content = match String::from_utf8(bytes) {
            Ok(content) => content,
            Err(_) => {
                result.skipped.push(ScanSkip {
                    relative_path,
                    reason: "file is not valid UTF-8".to_string(),
                });
                continue;
            }
        };

        result.files.push(ScannedFile {
            content_hash: hash_content(&content),
            size_bytes: metadata.len() as i64,
            modified_at: format_system_time(
                metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            ),
            relative_path,
        });
    }

    result.files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(result)
}

/// The generated fixture vault (see `scripts/generate-obsidian-test-vault.ps1`),
/// resolved relative to this crate regardless of the test runner's working
/// directory.
#[cfg(test)]
pub(crate) fn fixture_vault_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/ObsidianTestVault")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_fixture() -> ScanResult {
        let root = fixture_vault_path();
        assert!(
            root.exists(),
            "fixture vault missing at {root:?} — run scripts/generate-obsidian-test-vault.ps1 first"
        );
        scan_vault(&root, &ExcludeRules::default()).unwrap()
    }

    #[test]
    fn finds_exactly_the_markdown_files_outside_excluded_directories() {
        let result = scan_fixture();
        let paths: Vec<&str> = result.files.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(paths.contains(&"Projects/SaveSort Launch/Kickoff.md"));
        assert!(paths.contains(&"Templates/Daily Note Template.md"));
        assert!(!paths.iter().any(|p| p.starts_with(".obsidian/")));
        assert!(!paths.iter().any(|p| p.starts_with(".trash/")));
    }

    #[test]
    fn excludes_non_markdown_attachments() {
        let result = scan_fixture();
        let paths: Vec<&str> = result.files.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(!paths.iter().any(|p| p.ends_with(".png")));
        assert!(!paths.iter().any(|p| p.ends_with(".pdf")));
        assert!(!paths.iter().any(|p| p.ends_with(".canvas")));
    }

    #[test]
    fn preserves_unicode_folder_and_file_names() {
        let result = scan_fixture();
        let paths: Vec<&str> = result.files.iter().map(|f| f.relative_path.as_str()).collect();

        assert!(paths.contains(&"Projects/日本語プロジェクト/概要.md"));
        assert!(paths.contains(&"Areas/Health & Fitness/😀 Motivation.md"));
    }

    #[test]
    fn hashes_the_empty_note_as_the_hash_of_empty_content() {
        let result = scan_fixture();
        let empty = result
            .files
            .iter()
            .find(|f| f.relative_path == "Resources/Empty Note.md")
            .expect("Empty Note.md should be scanned");

        assert_eq!(empty.content_hash, hash_content(""));
        assert_eq!(empty.size_bytes, 0);
    }

    #[test]
    fn reads_the_near_1mb_note_completely() {
        let result = scan_fixture();
        let massive = result
            .files
            .iter()
            .find(|f| f.relative_path == "Massive Notes/Research Dump.md")
            .expect("Research Dump.md should be scanned");

        assert!(massive.size_bytes > 900_000, "expected a near-1MB note");
        // The hash must reflect the full content, not a truncated prefix.
        assert_eq!(massive.content_hash.len(), 64);
    }

    #[test]
    fn finds_no_duplicate_relative_paths() {
        let result = scan_fixture();
        let mut paths: Vec<&str> = result.files.iter().map(|f| f.relative_path.as_str()).collect();
        let before = paths.len();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), before);
    }
}
