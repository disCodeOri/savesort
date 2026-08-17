use rusqlite::Connection;

use crate::storage::StorageResult;

/// Runs the full schema in one transaction. `CREATE TABLE IF NOT EXISTS`
/// keeps this idempotent, so it is safe to call on every `Storage::open`
/// rather than tracking a separate migration version for a v1 schema.
pub(crate) fn migrate(connection: &Connection) -> StorageResult<()> {
    connection.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS files (
            client_file_id      TEXT PRIMARY KEY,
            relative_path       TEXT NOT NULL UNIQUE,
            content_hash        TEXT NOT NULL,
            size_bytes          INTEGER NOT NULL,
            modified_at         TEXT NOT NULL,
            last_synced_hash    TEXT,
            last_synced_revision INTEGER,
            sync_status         TEXT NOT NULL DEFAULT 'pending'
                CHECK (sync_status IN ('pending', 'synced', 'conflict', 'error')),
            last_error          TEXT,
            updated_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_queue (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            client_file_id      TEXT NOT NULL,
            operation           TEXT NOT NULL
                CHECK (operation IN ('upsert', 'delete', 'move')),
            payload             TEXT,
            status              TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'leased', 'done')),
            attempts            INTEGER NOT NULL DEFAULT 0,
            next_attempt_at     TEXT NOT NULL,
            lease_id            TEXT,
            leased_at           TEXT,
            last_error          TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sync_queue_ready_idx
            ON sync_queue (status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS sync_queue_file_idx
            ON sync_queue (client_file_id, status);

        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}
