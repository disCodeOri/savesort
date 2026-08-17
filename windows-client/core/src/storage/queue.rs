use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, StorageResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Operation {
    Upsert,
    Delete,
    Move,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Operation::Upsert => "upsert",
            Operation::Delete => "delete",
            Operation::Move => "move",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "delete" => Operation::Delete,
            "move" => Operation::Move,
            _ => Operation::Upsert,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueItem {
    pub id: i64,
    pub client_file_id: String,
    pub operation: Operation,
    /// Operation-specific extra data as raw JSON — e.g. a move's new path.
    /// Content itself is never stored here; it is re-read from disk at
    /// upload time so a file that changed again after being queued is never
    /// uploaded stale.
    pub payload: Option<String>,
    pub attempts: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueCounts {
    pub queued: i64,
    pub leased: i64,
}

fn read_item(row: &Row) -> rusqlite::Result<QueueItem> {
    Ok(QueueItem {
        id: row.get("id")?,
        client_file_id: row.get("client_file_id")?,
        operation: Operation::parse(&row.get::<_, String>("operation")?),
        payload: row.get("payload")?,
        attempts: row.get("attempts")?,
    })
}

impl Storage {
    /// Queues an operation for a file. If that file already has a queued
    /// (not yet leased) operation, this replaces it in place instead of
    /// appending a second row — the fix for "filesystem events can be
    /// duplicated" and "coalesce multiple events for the same file." A
    /// leased row is left alone; the new operation queues behind it and runs
    /// once the in-flight upload finishes.
    pub fn enqueue(
        &self,
        client_file_id: &str,
        operation: Operation,
        payload: Option<&str>,
        now: &str,
    ) -> StorageResult<i64> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM sync_queue
                 WHERE client_file_id = ?1 AND status = 'queued'",
                params![client_file_id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            conn.execute(
                "UPDATE sync_queue SET
                    operation = ?2, payload = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![id, operation.as_str(), payload, now],
            )?;
            return Ok(id);
        }

        conn.execute(
            "INSERT INTO sync_queue (
                client_file_id, operation, payload, status, attempts,
                next_attempt_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?4, ?4)",
            params![client_file_id, operation.as_str(), payload, now],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Atomically claims the oldest ready operation for a worker. Returns
    /// `None` when the queue is empty or every remaining item is either
    /// leased already or waiting out a backoff delay.
    pub fn lease_next(&self, lease_id: &str, now: &str) -> StorageResult<Option<QueueItem>> {
        let mut conn = self.conn.lock().expect("storage mutex poisoned");
        let tx = conn.transaction()?;

        let claimed = tx
            .query_row(
                "SELECT * FROM sync_queue
                 WHERE status = 'queued' AND next_attempt_at <= ?1
                 ORDER BY id ASC LIMIT 1",
                params![now],
                read_item,
            )
            .optional()?;

        let Some(item) = claimed else {
            return Ok(None);
        };

        tx.execute(
            "UPDATE sync_queue SET
                status = 'leased', lease_id = ?2, leased_at = ?3, updated_at = ?3
             WHERE id = ?1",
            params![item.id, lease_id, now],
        )?;
        tx.commit()?;
        Ok(Some(item))
    }

    /// Removes a completed operation. Only called after the server has
    /// confirmed the upload — this is what a crash between "upload sent" and
    /// "response received" leaves safely queued for a retry instead.
    pub fn mark_done(&self, id: i64) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute("DELETE FROM sync_queue WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Returns a failed operation to the queue with an incremented attempt
    /// count and the backoff-scheduled retry time the caller computed.
    pub fn mark_failed(
        &self,
        id: i64,
        next_attempt_at: &str,
        error: &str,
        now: &str,
    ) -> StorageResult<()> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        conn.execute(
            "UPDATE sync_queue SET
                status = 'queued',
                attempts = attempts + 1,
                lease_id = NULL,
                leased_at = NULL,
                next_attempt_at = ?2,
                last_error = ?3,
                updated_at = ?4
             WHERE id = ?1",
            params![id, next_attempt_at, error, now],
        )?;
        Ok(())
    }

    pub fn queue_counts(&self) -> StorageResult<QueueCounts> {
        let conn = self.conn.lock().expect("storage mutex poisoned");
        let mut counts = QueueCounts::default();
        let mut statement =
            conn.prepare("SELECT status, count(*) FROM sync_queue GROUP BY status")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (status, count) = row?;
            match status.as_str() {
                "queued" => counts.queued = count,
                "leased" => counts.leased = count,
                _ => {}
            }
        }
        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    const T0: &str = "2026-08-17T00:00:00Z";
    const T1: &str = "2026-08-17T00:00:05Z";

    #[test]
    fn enqueue_then_lease_returns_the_operation() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();

        let item = storage.lease_next("worker-1", T0).unwrap().unwrap();
        assert_eq!(item.client_file_id, "a");
        assert_eq!(item.operation, Operation::Upsert);
        assert_eq!(item.attempts, 0);
    }

    #[test]
    fn lease_next_returns_none_when_the_queue_is_empty() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.lease_next("worker-1", T0).unwrap().is_none());
    }

    #[test]
    fn a_leased_item_is_not_handed_to_a_second_worker() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();

        storage.lease_next("worker-1", T0).unwrap().unwrap();
        assert!(storage.lease_next("worker-2", T0).unwrap().is_none());
    }

    #[test]
    fn rapid_repeated_edits_coalesce_into_a_single_queued_operation() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();

        assert_eq!(storage.queue_counts().unwrap().queued, 1);
    }

    #[test]
    fn a_delete_after_a_queued_upsert_replaces_it_rather_than_stacking() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        storage.enqueue("a", Operation::Delete, None, T0).unwrap();

        assert_eq!(storage.queue_counts().unwrap().queued, 1);
        let item = storage.lease_next("worker-1", T0).unwrap().unwrap();
        assert_eq!(item.operation, Operation::Delete);
    }

    #[test]
    fn an_event_for_a_file_that_is_already_leased_queues_behind_it() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        storage.lease_next("worker-1", T0).unwrap().unwrap();

        // A second edit arrives while the first upload is in flight.
        storage.enqueue("a", Operation::Upsert, None, T1).unwrap();

        let counts = storage.queue_counts().unwrap();
        assert_eq!(counts.leased, 1);
        assert_eq!(counts.queued, 1);
    }

    #[test]
    fn mark_done_removes_the_operation() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        let item = storage.lease_next("worker-1", T0).unwrap().unwrap();

        storage.mark_done(item.id).unwrap();

        assert_eq!(storage.queue_counts().unwrap(), QueueCounts::default());
    }

    #[test]
    fn mark_failed_requeues_with_an_incremented_attempt_count() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        let item = storage.lease_next("worker-1", T0).unwrap().unwrap();

        storage
            .mark_failed(item.id, "2026-08-17T00:05:00Z", "network error", T0)
            .unwrap();

        // Not visible again before its scheduled retry time.
        assert!(storage.lease_next("worker-2", T0).unwrap().is_none());

        let retried = storage
            .lease_next("worker-2", "2026-08-17T00:05:00Z")
            .unwrap()
            .unwrap();
        assert_eq!(retried.attempts, 1);
    }

    #[test]
    fn a_failed_lease_is_available_to_a_different_worker_after_backoff() {
        let storage = Storage::open_in_memory().unwrap();
        storage.enqueue("a", Operation::Upsert, None, T0).unwrap();
        let first = storage.lease_next("worker-1", T0).unwrap().unwrap();
        storage
            .mark_failed(first.id, T1, "timeout", T0)
            .unwrap();

        let second = storage.lease_next("worker-2", T1).unwrap().unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.attempts, 1);
    }

    #[test]
    fn payload_round_trips_for_move_operations() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .enqueue(
                "a",
                Operation::Move,
                Some(r#"{"previousRelativePath":"Old.md"}"#),
                T0,
            )
            .unwrap();

        let item = storage.lease_next("worker-1", T0).unwrap().unwrap();
        assert_eq!(
            item.payload.as_deref(),
            Some(r#"{"previousRelativePath":"Old.md"}"#)
        );
    }
}
