mod manifest;
mod queue;
mod schema;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

pub use manifest::{FileRecord, SyncStatus};
pub use queue::{Operation, QueueCounts, QueueItem};

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("time formatting error: {0}")]
    Time(#[from] time::error::Format),
}

pub type StorageResult<T> = Result<T, StorageError>;

/// The durable local state for one vault: the file manifest (identity, hash,
/// last synced revision) and the sync operation queue. Both live in the same
/// SQLite file so a crash between "queue an operation" and "record the file's
/// new hash" is impossible — they commit in the same transaction where it
/// matters.
///
/// Methods take `&self`: the connection is behind a mutex so `Storage` can be
/// wrapped in an `Arc` and shared across the watcher, the worker, and Tauri
/// commands without each needing its own handle.
pub struct Storage {
    conn: Mutex<Connection>,
}

impl Storage {
    pub fn open(path: &Path) -> StorageResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// An in-memory database, for tests that don't need a file on disk.
    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> StorageResult<Self> {
        schema::migrate(&conn)?;
        let storage = Self {
            conn: Mutex::new(conn),
        };
        // A process restart means no worker actually holds any lease it left
        // behind, so every 'leased' row is really just 'queued' again. This is
        // what makes the queue survive an app or Windows restart without a
        // separate stale-lease sweep.
        storage.reclaim_leases_on_open()?;
        Ok(storage)
    }

    fn reclaim_leases_on_open(&self) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE sync_queue
             SET status = 'queued', lease_id = NULL, leased_at = NULL
             WHERE status = 'leased'",
            [],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_the_schema() {
        let storage = Storage::open_in_memory().unwrap();
        let conn = storage.conn.lock().unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN ('files', 'sync_queue', 'sync_state')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 3);
    }

    #[test]
    fn open_on_a_file_path_persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("vault.sqlite3");

        {
            let storage = Storage::open(&db_path).unwrap();
            storage
                .upsert_file(&FileRecord {
                    client_file_id: "a".into(),
                    relative_path: "Note.md".into(),
                    content_hash: "hash-a".into(),
                    size_bytes: 10,
                    modified_at: "2026-08-17T00:00:00Z".into(),
                    last_synced_hash: None,
                    last_synced_revision: None,
                    sync_status: SyncStatus::Pending,
                    last_error: None,
                })
                .unwrap();
        }

        let reopened = Storage::open(&db_path).unwrap();
        let record = reopened.get_file("a").unwrap().unwrap();
        assert_eq!(record.content_hash, "hash-a");
    }

    #[test]
    fn reopening_resets_a_lease_left_by_a_crashed_process() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("vault.sqlite3");

        {
            let storage = Storage::open(&db_path).unwrap();
            storage
                .enqueue("a", Operation::Upsert, None, "2026-08-17T00:00:00Z")
                .unwrap();
            let leased = storage
                .lease_next("worker-1", "2026-08-17T00:00:00Z")
                .unwrap()
                .expect("an item should be leasable");
            assert_eq!(leased.client_file_id, "a");
            // Simulate a crash: storage is dropped without mark_done.
        }

        let reopened = Storage::open(&db_path).unwrap();
        let leased_again = reopened
            .lease_next("worker-2", "2026-08-17T00:05:00Z")
            .unwrap()
            .expect("the reclaimed item should be leasable again");
        assert_eq!(leased_again.client_file_id, "a");
    }
}
