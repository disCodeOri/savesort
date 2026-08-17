use std::path::Path;

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::backoff;
use crate::hashing::hash_content;
use crate::storage::{FileRecord, Operation, QueueItem, Storage, StorageError, SyncStatus};
use crate::sync::{
    DeleteFileEntry, MoveFileEntry, NoteResult, NoteResultStatus, SyncApi, SyncApiError,
    SyncFileUpload,
};

#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("could not read note content: {0}")]
    Io(String),
    #[error("access token was rejected")]
    Unauthorized,
    #[error("sync api error: {0}")]
    Api(String),
    /// A queued operation referenced a file id that no longer has a
    /// manifest row. Not expected in normal operation, but not fatal either
    /// — the item is simply dropped rather than retried forever.
    #[error("no manifest record for a queued file")]
    MissingRecord,
}

impl From<SyncApiError> for WorkerError {
    fn from(error: SyncApiError) -> Self {
        match error {
            SyncApiError::Unauthorized => WorkerError::Unauthorized,
            other => WorkerError::Api(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessedOutcome {
    Synced,
    Conflict { message: Option<String> },
    RetryScheduled { next_attempt_at: String },
    /// The caller should refresh the access token; the item is already
    /// requeued for an immediate retry once that happens.
    ReauthRequired,
}

fn format_rfc3339(time: OffsetDateTime) -> String {
    time.format(&Rfc3339).unwrap_or_default()
}

fn read_note_content(vault_root: &Path, relative_path: &str) -> std::io::Result<String> {
    let absolute = vault_root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let bytes = std::fs::read(absolute)?;
    String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn require_record(storage: &Storage, client_file_id: &str) -> Result<FileRecord, WorkerError> {
    storage
        .get_file(client_file_id)?
        .ok_or(WorkerError::MissingRecord)
}

fn require_result(results: Vec<NoteResult>, client_file_id: &str) -> Result<NoteResult, WorkerError> {
    results
        .into_iter()
        .find(|result| result.client_file_id == client_file_id)
        .ok_or_else(|| WorkerError::Api("server response did not include this file".into()))
}

/// Reschedules a failed operation using the standard backoff table and
/// records why, so the tray can show a meaningful error instead of "failed".
fn schedule_retry(
    storage: &Storage,
    item: &QueueItem,
    now: OffsetDateTime,
    message: &str,
) -> Result<ProcessedOutcome, WorkerError> {
    let attempts = item.attempts + 1;
    let delay = backoff::delay_seconds(attempts.max(0) as u32);
    let next_attempt_at = format_rfc3339(now + time::Duration::seconds(delay as i64));
    storage.mark_failed(item.id, &next_attempt_at, message, &format_rfc3339(now))?;
    Ok(ProcessedOutcome::RetryScheduled { next_attempt_at })
}

async fn process_upsert<A: SyncApi>(
    storage: &Storage,
    api: &A,
    vault_root: &Path,
    vault_id: &str,
    access_token: &str,
    item: &QueueItem,
) -> Result<ProcessedOutcome, WorkerError> {
    let record = require_record(storage, &item.client_file_id)?;

    // Read fresh from disk rather than trusting anything captured when the
    // operation was queued — the file may have changed again since then.
    let content = match read_note_content(vault_root, &record.relative_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Queued as an edit, but the file is gone by the time we got to
            // it. The delete is the operation that actually reflects reality.
            return process_delete(storage, api, vault_id, access_token, item).await;
        }
        Err(error) => return Err(WorkerError::Io(error.to_string())),
    };
    let content_hash = hash_content(&content);

    let results = api
        .upload_batch(
            access_token,
            vault_id,
            &[SyncFileUpload {
                client_file_id: item.client_file_id.clone(),
                relative_path: record.relative_path.clone(),
                content,
                content_hash: content_hash.clone(),
                modified_at: None,
                base_revision: record.last_synced_revision,
            }],
        )
        .await?;
    let result = require_result(results, &item.client_file_id)?;

    match result.status {
        NoteResultStatus::Created | NoteResultStatus::Updated | NoteResultStatus::Unchanged => {
            let revision = result.revision.unwrap_or(record.last_synced_revision.unwrap_or(0));
            storage.mark_synced(&item.client_file_id, &content_hash, revision)?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Synced)
        }
        NoteResultStatus::Conflict => {
            storage.mark_status(&item.client_file_id, SyncStatus::Conflict, result.message.as_deref())?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Conflict { message: result.message })
        }
        // These statuses are not reachable from an upsert response, but
        // treated as a soft failure rather than a panic if the server ever
        // sends one — a bug on one side should not crash the other.
        NoteResultStatus::Deleted
        | NoteResultStatus::Moved
        | NoteResultStatus::Missing
        | NoteResultStatus::Error => {
            let message = result.message.unwrap_or_else(|| "unexpected server response".into());
            schedule_retry(storage, item, OffsetDateTime::now_utc(), &message)
        }
    }
}

async fn process_delete<A: SyncApi>(
    storage: &Storage,
    api: &A,
    vault_id: &str,
    access_token: &str,
    item: &QueueItem,
) -> Result<ProcessedOutcome, WorkerError> {
    // The record may already be gone if this delete was redirected here from
    // a stale upsert; a missing base revision just means "delete whatever is
    // there," which the server already treats as a safe no-op if it agrees.
    let base_revision = storage
        .get_file(&item.client_file_id)?
        .and_then(|record| record.last_synced_revision);

    let results = api
        .delete_files(
            access_token,
            vault_id,
            &[DeleteFileEntry {
                client_file_id: item.client_file_id.clone(),
                base_revision,
            }],
        )
        .await?;
    let result = require_result(results, &item.client_file_id)?;

    match result.status {
        NoteResultStatus::Deleted | NoteResultStatus::Missing | NoteResultStatus::Unchanged => {
            storage.delete_file(&item.client_file_id)?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Synced)
        }
        NoteResultStatus::Conflict => {
            // The server has a newer edit than the one this delete was based
            // on. Local content is already gone, so there is nothing to
            // preserve; surface it as needing attention rather than
            // silently retrying forever.
            storage.mark_status(&item.client_file_id, SyncStatus::Conflict, result.message.as_deref())?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Conflict { message: result.message })
        }
        _ => {
            let message = result.message.unwrap_or_else(|| "unexpected server response".into());
            schedule_retry(storage, item, OffsetDateTime::now_utc(), &message)
        }
    }
}

async fn process_move<A: SyncApi>(
    storage: &Storage,
    api: &A,
    vault_id: &str,
    access_token: &str,
    item: &QueueItem,
) -> Result<ProcessedOutcome, WorkerError> {
    let record = require_record(storage, &item.client_file_id)?;

    let results = api
        .move_files(
            access_token,
            vault_id,
            &[MoveFileEntry {
                client_file_id: item.client_file_id.clone(),
                relative_path: record.relative_path.clone(),
                base_revision: record.last_synced_revision,
            }],
        )
        .await?;
    let result = require_result(results, &item.client_file_id)?;

    match result.status {
        NoteResultStatus::Moved | NoteResultStatus::Unchanged => {
            let revision = result.revision.unwrap_or(record.last_synced_revision.unwrap_or(0));
            storage.mark_synced(&item.client_file_id, &record.content_hash, revision)?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Synced)
        }
        NoteResultStatus::Conflict => {
            storage.mark_status(&item.client_file_id, SyncStatus::Conflict, result.message.as_deref())?;
            storage.mark_done(item.id)?;
            Ok(ProcessedOutcome::Conflict { message: result.message })
        }
        _ => {
            let message = result.message.unwrap_or_else(|| "unexpected server response".into());
            schedule_retry(storage, item, OffsetDateTime::now_utc(), &message)
        }
    }
}

/// Processes exactly one queued operation: leases it, performs the network
/// call, and updates local state from the result. Returns `Ok(None)` when
/// there is nothing ready to process. The caller is expected to call this in
/// a loop — draining a backlog after an outage, or handling one live event —
/// and to refresh the access token and call again on `ReauthRequired`.
pub async fn process_next<A: SyncApi>(
    storage: &Storage,
    api: &A,
    vault_root: &Path,
    vault_id: &str,
    access_token: &str,
    lease_id: &str,
    now: OffsetDateTime,
) -> Result<Option<ProcessedOutcome>, WorkerError> {
    let now_iso = format_rfc3339(now);
    let Some(item) = storage.lease_next(lease_id, &now_iso)? else {
        return Ok(None);
    };

    let outcome = match item.operation {
        Operation::Upsert => process_upsert(storage, api, vault_root, vault_id, access_token, &item).await,
        Operation::Delete => process_delete(storage, api, vault_id, access_token, &item).await,
        Operation::Move => process_move(storage, api, vault_id, access_token, &item).await,
    };

    match outcome {
        Ok(outcome) => Ok(Some(outcome)),
        Err(WorkerError::Unauthorized) => {
            // Retryable almost immediately — this is an expired token, not a
            // transient failure of the note itself, so the full backoff
            // schedule would be an unnecessary delay once the caller
            // refreshes.
            storage.mark_failed(item.id, &now_iso, "access token expired", &now_iso)?;
            Ok(Some(ProcessedOutcome::ReauthRequired))
        }
        Err(error) => Ok(Some(schedule_retry(storage, &item, now, &error.to_string())?)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tempfile::tempdir;
    use time::macros::datetime;

    use super::*;
    use crate::storage::FileRecord;
    use crate::sync::{ChangesPage, RegisterVaultRequest, VaultSummary};

    /// Scripted in-memory implementation of `SyncApi`. Each call consumes the
    /// next entry from `upload_responses`/`delete_responses`/`move_responses`
    /// in order, so tests can assert exactly what the worker sent and control
    /// exactly what it gets back — no real network involved.
    #[derive(Default)]
    struct FakeApi {
        upload_responses: Mutex<Vec<Result<Vec<NoteResult>, SyncApiError>>>,
        delete_responses: Mutex<Vec<Result<Vec<NoteResult>, SyncApiError>>>,
        move_responses: Mutex<Vec<Result<Vec<NoteResult>, SyncApiError>>>,
        pub sent_uploads: Mutex<Vec<SyncFileUpload>>,
    }

    impl SyncApi for FakeApi {
        async fn register_vault(
            &self,
            _access_token: &str,
            _request: &RegisterVaultRequest,
        ) -> Result<VaultSummary, SyncApiError> {
            unimplemented!("not exercised by worker tests")
        }

        async fn upload_batch(
            &self,
            _access_token: &str,
            _vault_id: &str,
            files: &[SyncFileUpload],
        ) -> Result<Vec<NoteResult>, SyncApiError> {
            self.sent_uploads.lock().unwrap().extend_from_slice(files);
            self.upload_responses.lock().unwrap().remove(0)
        }

        async fn delete_files(
            &self,
            _access_token: &str,
            _vault_id: &str,
            _files: &[DeleteFileEntry],
        ) -> Result<Vec<NoteResult>, SyncApiError> {
            self.delete_responses.lock().unwrap().remove(0)
        }

        async fn move_files(
            &self,
            _access_token: &str,
            _vault_id: &str,
            _files: &[MoveFileEntry],
        ) -> Result<Vec<NoteResult>, SyncApiError> {
            self.move_responses.lock().unwrap().remove(0)
        }

        async fn get_status(
            &self,
            _access_token: &str,
            _vault_id: &str,
            _mark_full_scan_completed: bool,
        ) -> Result<VaultSummary, SyncApiError> {
            unimplemented!("not exercised by worker tests")
        }

        async fn get_changes(
            &self,
            _access_token: &str,
            _vault_id: &str,
            _since: Option<&str>,
            _limit: u32,
        ) -> Result<ChangesPage, SyncApiError> {
            unimplemented!("not exercised by worker tests")
        }
    }

    fn note_result(client_file_id: &str, status: NoteResultStatus, revision: Option<i64>) -> NoteResult {
        NoteResult {
            client_file_id: client_file_id.into(),
            status,
            revision,
            server_content_hash: None,
            server_relative_path: None,
            message: None,
        }
    }

    const NOW: time::OffsetDateTime = datetime!(2026-08-17 00:00:00 UTC);

    fn seed_vault_with_file(vault_root: &Path, relative_path: &str, content: &str) -> String {
        let absolute = vault_root.join(relative_path);
        std::fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        std::fs::write(&absolute, content).unwrap();
        hash_content(content)
    }

    #[tokio::test]
    async fn a_successful_upsert_marks_the_file_synced_and_clears_the_queue() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        let hash = seed_vault_with_file(vault.path(), "Note.md", "# Hello");

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: hash.clone(),
                size_bytes: 7,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: None,
                last_synced_revision: None,
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage
            .enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z")
            .unwrap();

        let api = FakeApi {
            upload_responses: Mutex::new(vec![Ok(vec![note_result("a", NoteResultStatus::Created, Some(1))])]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert_eq!(outcome, Some(ProcessedOutcome::Synced));
        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.sync_status, SyncStatus::Synced);
        assert_eq!(record.last_synced_revision, Some(1));
        assert_eq!(storage.queue_counts().unwrap().queued, 0);
    }

    #[tokio::test]
    async fn reads_content_fresh_from_disk_rather_than_anything_cached_at_queue_time() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        seed_vault_with_file(vault.path(), "Note.md", "# Original");

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: "stale-hash-from-when-it-was-queued".into(),
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: None,
                last_synced_revision: None,
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z").unwrap();

        // The file changes again after being queued but before the worker runs.
        std::fs::write(vault.path().join("Note.md"), "# Edited again").unwrap();
        let true_hash = hash_content("# Edited again");

        let api = FakeApi {
            upload_responses: Mutex::new(vec![Ok(vec![note_result("a", NoteResultStatus::Updated, Some(2))])]),
            ..Default::default()
        };

        process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        let sent = api.sent_uploads.lock().unwrap();
        assert_eq!(sent[0].content_hash, true_hash);
        assert_eq!(sent[0].content, "# Edited again");
    }

    #[tokio::test]
    async fn a_conflict_response_leaves_the_local_file_untouched_and_stops_retrying() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        let hash = seed_vault_with_file(vault.path(), "Note.md", "# Local edit");

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: hash,
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: Some("old-hash".into()),
                last_synced_revision: Some(1),
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z").unwrap();

        let api = FakeApi {
            upload_responses: Mutex::new(vec![Ok(vec![NoteResult {
                client_file_id: "a".into(),
                status: NoteResultStatus::Conflict,
                revision: Some(2),
                server_content_hash: Some("someone-elses-hash".into()),
                server_relative_path: None,
                message: Some("server has a newer revision".into()),
            }])]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert!(matches!(outcome, Some(ProcessedOutcome::Conflict { .. })));
        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.sync_status, SyncStatus::Conflict);
        // The local file content is untouched — still exactly what was read.
        assert_eq!(
            std::fs::read_to_string(vault.path().join("Note.md")).unwrap(),
            "# Local edit"
        );
        // A conflict does not sit in the queue retrying forever.
        assert_eq!(storage.queue_counts().unwrap().queued, 0);
    }

    #[tokio::test]
    async fn a_network_error_schedules_a_backoff_retry_without_losing_the_operation() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        seed_vault_with_file(vault.path(), "Note.md", "# Hello");

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: hash_content("# Hello"),
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: None,
                last_synced_revision: None,
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z").unwrap();

        let api = FakeApi {
            upload_responses: Mutex::new(vec![Err(SyncApiError::Rejected {
                code: "server_error".into(),
                message: "database details".into(),
            })]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert!(matches!(outcome, Some(ProcessedOutcome::RetryScheduled { .. })));
        assert_eq!(storage.queue_counts().unwrap().queued, 1);
        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.sync_status, SyncStatus::Pending); // not marked synced
    }

    #[tokio::test]
    async fn an_unauthorized_response_requeues_for_an_immediate_retry() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        seed_vault_with_file(vault.path(), "Note.md", "# Hello");

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: hash_content("# Hello"),
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: None,
                last_synced_revision: None,
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z").unwrap();

        let api = FakeApi {
            upload_responses: Mutex::new(vec![Err(SyncApiError::Unauthorized)]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "stale-token", "lease-1", NOW)
            .await
            .unwrap();

        assert_eq!(outcome, Some(ProcessedOutcome::ReauthRequired));
        // Immediately leasable again — the caller is expected to refresh and retry.
        let re_leased = storage.lease_next("lease-2", &format_rfc3339(NOW)).unwrap();
        assert!(re_leased.is_some());
    }

    #[tokio::test]
    async fn a_file_deleted_after_being_queued_as_an_upsert_is_deleted_instead_of_erroring() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        // No file is created on disk — it was queued, then removed before
        // the worker got to it.
        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "Note.md".into(),
                content_hash: "whatever".into(),
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: Some("whatever".into()),
                last_synced_revision: Some(1),
                sync_status: SyncStatus::Synced,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z").unwrap();

        let api = FakeApi {
            delete_responses: Mutex::new(vec![Ok(vec![note_result("a", NoteResultStatus::Deleted, Some(2))])]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert_eq!(outcome, Some(ProcessedOutcome::Synced));
        assert!(storage.get_file("a").unwrap().is_none());
    }

    #[tokio::test]
    async fn a_successful_move_updates_the_revision_without_changing_the_hash() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();

        storage
            .upsert_file(&FileRecord {
                client_file_id: "a".into(),
                relative_path: "New/Note.md".into(),
                content_hash: "unchanged-hash".into(),
                size_bytes: 1,
                modified_at: "2026-08-17T00:00:00Z".into(),
                last_synced_hash: Some("unchanged-hash".into()),
                last_synced_revision: Some(1),
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .unwrap();
        storage.enqueue("a", Operation::Move, None, "2026-08-17T00:00:00Z").unwrap();

        let api = FakeApi {
            move_responses: Mutex::new(vec![Ok(vec![note_result("a", NoteResultStatus::Moved, Some(2))])]),
            ..Default::default()
        };

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert_eq!(outcome, Some(ProcessedOutcome::Synced));
        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.content_hash, "unchanged-hash");
        assert_eq!(record.last_synced_revision, Some(2));
    }

    #[tokio::test]
    async fn an_empty_queue_returns_none_without_calling_the_api() {
        let storage = Storage::open_in_memory().unwrap();
        let vault = tempdir().unwrap();
        let api = FakeApi::default();

        let outcome = process_next(&storage, &api, vault.path(), "vault-1", "token", "lease-1", NOW)
            .await
            .unwrap();

        assert_eq!(outcome, None);
    }
}
