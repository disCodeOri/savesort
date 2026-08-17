use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, StorageResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncStatus {
    /// Discovered or changed locally; not yet confirmed on the server.
    Pending,
    /// The server's hash matches ours as of `last_synced_hash`.
    Synced,
    /// The server rejected our upload because our `baseRevision` was stale.
    /// The local file is left untouched until the user resolves it.
    Conflict,
    /// The last sync attempt failed for a reason other than a conflict.
    Error,
}

impl SyncStatus {
    fn as_str(self) -> &'static str {
        match self {
            SyncStatus::Pending => "pending",
            SyncStatus::Synced => "synced",
            SyncStatus::Conflict => "conflict",
            SyncStatus::Error => "error",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "synced" => SyncStatus::Synced,
            "conflict" => SyncStatus::Conflict,
            "error" => SyncStatus::Error,
            _ => SyncStatus::Pending,
        }
    }
}

/// The client's record of one note. `client_file_id` is the stable identity —
/// a rename changes `relative_path` on the same row rather than creating a
/// new one, which is what lets the server treat a move as an update instead
/// of a delete-and-recreate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileRecord {
    pub client_file_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub size_bytes: i64,
    pub modified_at: String,
    pub last_synced_hash: Option<String>,
    pub last_synced_revision: Option<i64>,
    pub sync_status: SyncStatus,
    pub last_error: Option<String>,
}

fn read_record(row: &Row) -> rusqlite::Result<FileRecord> {
    Ok(FileRecord {
        client_file_id: row.get("client_file_id")?,
        relative_path: row.get("relative_path")?,
        content_hash: row.get("content_hash")?,
        size_bytes: row.get("size_bytes")?,
        modified_at: row.get("modified_at")?,
        last_synced_hash: row.get("last_synced_hash")?,
        last_synced_revision: row.get("last_synced_revision")?,
        sync_status: SyncStatus::parse(&row.get::<_, String>("sync_status")?),
        last_error: row.get("last_error")?,
    })
}

impl Storage {
    /// Inserts a new note or overwrites the existing row for the same file
    /// id. Used both when the watcher discovers a file and when the worker
    /// updates sync state after a server response.
    pub fn upsert_file(&self, record: &FileRecord) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "INSERT INTO files (
                client_file_id, relative_path, content_hash, size_bytes,
                modified_at, last_synced_hash, last_synced_revision,
                sync_status, last_error, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (client_file_id) DO UPDATE SET
                relative_path = excluded.relative_path,
                content_hash = excluded.content_hash,
                size_bytes = excluded.size_bytes,
                modified_at = excluded.modified_at,
                last_synced_hash = excluded.last_synced_hash,
                last_synced_revision = excluded.last_synced_revision,
                sync_status = excluded.sync_status,
                last_error = excluded.last_error,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![
                record.client_file_id,
                record.relative_path,
                record.content_hash,
                record.size_bytes,
                record.modified_at,
                record.last_synced_hash,
                record.last_synced_revision,
                record.sync_status.as_str(),
                record.last_error,
            ],
        )?;
        Ok(())
    }

    pub fn get_file(&self, client_file_id: &str) -> StorageResult<Option<FileRecord>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let record = conn
            .query_row(
                "SELECT * FROM files WHERE client_file_id = ?1",
                params![client_file_id],
                read_record,
            )
            .optional()?;
        Ok(record)
    }

    /// Looked up by path when the watcher sees an event and needs to know
    /// whether this path is already a known file (an edit) or new.
    pub fn get_file_by_path(&self, relative_path: &str) -> StorageResult<Option<FileRecord>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let record = conn
            .query_row(
                "SELECT * FROM files WHERE relative_path = ?1",
                params![relative_path],
                read_record,
            )
            .optional()?;
        Ok(record)
    }

    /// Records that the server accepted this exact content as the given
    /// revision. Called after a successful upload so the next reconciliation
    /// scan sees this file as already in sync.
    pub fn mark_synced(
        &self,
        client_file_id: &str,
        content_hash: &str,
        revision: i64,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE files SET
                last_synced_hash = ?2,
                last_synced_revision = ?3,
                sync_status = 'synced',
                last_error = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE client_file_id = ?1",
            params![client_file_id, content_hash, revision],
        )?;
        Ok(())
    }

    pub fn mark_status(
        &self,
        client_file_id: &str,
        status: SyncStatus,
        error: Option<&str>,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE files SET
                sync_status = ?2,
                last_error = ?3,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE client_file_id = ?1",
            params![client_file_id, status.as_str(), error],
        )?;
        Ok(())
    }

    pub fn delete_file(&self, client_file_id: &str) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "DELETE FROM files WHERE client_file_id = ?1",
            params![client_file_id],
        )?;
        Ok(())
    }

    /// The whole manifest, used by the periodic reconciliation scan to diff
    /// against both a fresh filesystem walk and the server's `/api/sync/changes`
    /// manifest.
    pub fn list_all_files(&self) -> StorageResult<Vec<FileRecord>> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut statement = conn.prepare("SELECT * FROM files ORDER BY relative_path")?;
        let records = statement
            .query_map([], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn sample(id: &str, hash: &str) -> FileRecord {
        FileRecord {
            client_file_id: id.into(),
            relative_path: format!("Notes/{id}.md"),
            content_hash: hash.into(),
            size_bytes: 42,
            modified_at: "2026-08-17T00:00:00Z".into(),
            last_synced_hash: None,
            last_synced_revision: None,
            sync_status: SyncStatus::Pending,
            last_error: None,
        }
    }

    #[test]
    fn upsert_then_get_round_trips_the_record() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();

        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.content_hash, "hash-1");
        assert_eq!(record.sync_status, SyncStatus::Pending);
    }

    #[test]
    fn upserting_the_same_id_again_updates_in_place_without_duplicating() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();
        storage.upsert_file(&sample("a", "hash-2")).unwrap();

        assert_eq!(storage.get_file("a").unwrap().unwrap().content_hash, "hash-2");
        assert_eq!(storage.list_all_files().unwrap().len(), 1);
    }

    #[test]
    fn looks_up_by_relative_path() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();

        let record = storage.get_file_by_path("Notes/a.md").unwrap().unwrap();
        assert_eq!(record.client_file_id, "a");
        assert!(storage.get_file_by_path("Notes/missing.md").unwrap().is_none());
    }

    #[test]
    fn mark_synced_records_the_confirmed_revision() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();

        storage.mark_synced("a", "hash-1", 3).unwrap();

        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.sync_status, SyncStatus::Synced);
        assert_eq!(record.last_synced_hash.as_deref(), Some("hash-1"));
        assert_eq!(record.last_synced_revision, Some(3));
    }

    #[test]
    fn mark_status_records_a_conflict_with_its_message() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();

        storage
            .mark_status("a", SyncStatus::Conflict, Some("server has a newer revision"))
            .unwrap();

        let record = storage.get_file("a").unwrap().unwrap();
        assert_eq!(record.sync_status, SyncStatus::Conflict);
        assert_eq!(
            record.last_error.as_deref(),
            Some("server has a newer revision")
        );
    }

    #[test]
    fn delete_removes_the_row() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();

        storage.delete_file("a").unwrap();

        assert!(storage.get_file("a").unwrap().is_none());
    }

    #[test]
    fn list_all_files_is_used_by_reconciliation_to_see_the_whole_manifest() {
        let storage = Storage::open_in_memory().unwrap();
        storage.upsert_file(&sample("a", "hash-1")).unwrap();
        storage.upsert_file(&sample("b", "hash-2")).unwrap();

        let all = storage.list_all_files().unwrap();
        assert_eq!(all.len(), 2);
    }
}
