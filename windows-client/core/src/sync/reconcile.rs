use std::collections::{HashMap, HashSet};

use crate::storage::FileRecord;
use crate::watcher::ScannedFile;

/// What a fresh vault scan implies about the local manifest. Pure and
/// deterministic — no I/O, no client-file-id generation — so a "missed
/// event" scenario is fully testable without touching a real filesystem.
/// This is the fallback for what filesystem watchers miss: a periodic scan
/// plus this diff, not events alone.
#[derive(Debug, Clone, PartialEq)]
pub enum ReconcileAction {
    /// A path with no matching manifest entry and no plausible prior
    /// location (see `Moved`). The caller assigns a fresh client file id.
    New {
        relative_path: String,
        content_hash: String,
        size_bytes: i64,
        modified_at: String,
    },
    /// A known file whose content changed since the manifest was written.
    Changed {
        client_file_id: String,
        relative_path: String,
        content_hash: String,
        size_bytes: i64,
        modified_at: String,
    },
    /// A manifest entry's path vanished, but a new path with the *same*
    /// content hash appeared — almost certainly a rename or move the watcher
    /// missed (e.g. it happened while the app was closed), so this is
    /// reported as a move rather than a delete-and-recreate.
    Moved {
        client_file_id: String,
        from_relative_path: String,
        to_relative_path: String,
    },
    /// A manifest entry's path is gone with no matching content elsewhere.
    Deleted { client_file_id: String },
}

/// Diffs a fresh scan against the current manifest. `existing` and `scanned`
/// need not be sorted.
pub fn plan_from_scan(existing: &[FileRecord], scanned: &[ScannedFile]) -> Vec<ReconcileAction> {
    let existing_by_path: HashMap<&str, &FileRecord> = existing
        .iter()
        .map(|record| (record.relative_path.as_str(), record))
        .collect();
    let scanned_paths: HashSet<&str> = scanned.iter().map(|file| file.relative_path.as_str()).collect();

    // Entries a rename could plausibly explain: present in the manifest but
    // missing from disk. Indexed by hash so a moved file's new path can find
    // its old identity in one lookup.
    let mut missing_by_hash: HashMap<&str, Vec<&FileRecord>> = HashMap::new();
    for record in existing {
        if !scanned_paths.contains(record.relative_path.as_str()) {
            missing_by_hash
                .entry(record.content_hash.as_str())
                .or_default()
                .push(record);
        }
    }

    let mut actions = Vec::new();
    let mut consumed_as_moved: HashSet<String> = HashSet::new();

    for file in scanned {
        if let Some(record) = existing_by_path.get(file.relative_path.as_str()) {
            if record.content_hash != file.content_hash {
                actions.push(ReconcileAction::Changed {
                    client_file_id: record.client_file_id.clone(),
                    relative_path: file.relative_path.clone(),
                    content_hash: file.content_hash.clone(),
                    size_bytes: file.size_bytes,
                    modified_at: file.modified_at.clone(),
                });
            }
            continue;
        }

        let moved_from = missing_by_hash
            .get_mut(file.content_hash.as_str())
            .and_then(|candidates| {
                candidates
                    .iter()
                    .position(|candidate| !consumed_as_moved.contains(&candidate.client_file_id))
                    .map(|index| candidates.remove(index))
            });

        match moved_from {
            Some(record) => {
                consumed_as_moved.insert(record.client_file_id.clone());
                actions.push(ReconcileAction::Moved {
                    client_file_id: record.client_file_id.clone(),
                    from_relative_path: record.relative_path.clone(),
                    to_relative_path: file.relative_path.clone(),
                });
            }
            None => actions.push(ReconcileAction::New {
                relative_path: file.relative_path.clone(),
                content_hash: file.content_hash.clone(),
                size_bytes: file.size_bytes,
                modified_at: file.modified_at.clone(),
            }),
        }
    }

    for record in existing {
        if scanned_paths.contains(record.relative_path.as_str())
            || consumed_as_moved.contains(&record.client_file_id)
        {
            continue;
        }
        actions.push(ReconcileAction::Deleted {
            client_file_id: record.client_file_id.clone(),
        });
    }

    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SyncStatus;

    fn record(id: &str, path: &str, hash: &str) -> FileRecord {
        FileRecord {
            client_file_id: id.into(),
            relative_path: path.into(),
            content_hash: hash.into(),
            size_bytes: 10,
            modified_at: "2026-08-17T00:00:00Z".into(),
            last_synced_hash: Some(hash.into()),
            last_synced_revision: Some(1),
            sync_status: SyncStatus::Synced,
            last_error: None,
        }
    }

    fn scanned(path: &str, hash: &str) -> ScannedFile {
        ScannedFile {
            relative_path: path.into(),
            content_hash: hash.into(),
            size_bytes: 10,
            modified_at: "2026-08-17T00:05:00Z".into(),
        }
    }

    #[test]
    fn a_path_with_no_manifest_entry_and_no_hash_match_is_new() {
        let actions = plan_from_scan(&[], &[scanned("A.md", "hash-a")]);
        assert_eq!(
            actions,
            vec![ReconcileAction::New {
                relative_path: "A.md".into(),
                content_hash: "hash-a".into(),
                size_bytes: 10,
                modified_at: "2026-08-17T00:05:00Z".into(),
            }]
        );
    }

    #[test]
    fn a_matching_path_and_hash_produces_no_action() {
        let existing = [record("id-a", "A.md", "hash-a")];
        let actions = plan_from_scan(&existing, &[scanned("A.md", "hash-a")]);
        assert!(actions.is_empty());
    }

    #[test]
    fn a_matching_path_with_a_different_hash_is_changed() {
        let existing = [record("id-a", "A.md", "hash-old")];
        let actions = plan_from_scan(&existing, &[scanned("A.md", "hash-new")]);
        assert_eq!(
            actions,
            vec![ReconcileAction::Changed {
                client_file_id: "id-a".into(),
                relative_path: "A.md".into(),
                content_hash: "hash-new".into(),
                size_bytes: 10,
                modified_at: "2026-08-17T00:05:00Z".into(),
            }]
        );
    }

    #[test]
    fn a_manifest_entry_missing_from_the_scan_is_deleted() {
        let existing = [record("id-a", "A.md", "hash-a")];
        let actions = plan_from_scan(&existing, &[]);
        assert_eq!(
            actions,
            vec![ReconcileAction::Deleted {
                client_file_id: "id-a".into()
            }]
        );
    }

    #[test]
    fn a_missing_path_paired_with_identical_content_elsewhere_is_a_move_not_a_delete_and_recreate() {
        let existing = [record("id-a", "Old/A.md", "hash-a")];
        let actions = plan_from_scan(&existing, &[scanned("New/A.md", "hash-a")]);
        assert_eq!(
            actions,
            vec![ReconcileAction::Moved {
                client_file_id: "id-a".into(),
                from_relative_path: "Old/A.md".into(),
                to_relative_path: "New/A.md".into(),
            }]
        );
    }

    #[test]
    fn two_missing_files_with_the_same_hash_each_match_a_distinct_new_path() {
        // A watcher restart could plausibly leave two identical-content notes
        // both "missing"; each new path should claim one, not double-claim.
        let existing = [
            record("id-a", "Old/A.md", "same-hash"),
            record("id-b", "Old/B.md", "same-hash"),
        ];
        let scan = [scanned("New/A.md", "same-hash"), scanned("New/B.md", "same-hash")];
        let actions = plan_from_scan(&existing, &scan);

        assert_eq!(actions.len(), 2);
        let moved_ids: HashSet<&str> = actions
            .iter()
            .filter_map(|action| match action {
                ReconcileAction::Moved { client_file_id, .. } => Some(client_file_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(moved_ids, HashSet::from(["id-a", "id-b"]));
    }

    #[test]
    fn an_untouched_file_alongside_other_changes_produces_no_action_for_itself() {
        let existing = [record("id-a", "A.md", "hash-a"), record("id-b", "B.md", "hash-b")];
        let actions = plan_from_scan(&existing, &[scanned("A.md", "hash-a"), scanned("B.md", "hash-b-changed")]);

        assert_eq!(actions.len(), 1);
        assert!(matches!(&actions[0], ReconcileAction::Changed { client_file_id, .. } if client_file_id == "id-b"));
    }
}
