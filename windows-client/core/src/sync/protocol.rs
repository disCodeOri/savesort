use serde::{Deserialize, Serialize};

/// These types mirror `src/lib/obsidian/schemas.ts` and `src/lib/obsidian/notes.ts`
/// on the server field for field. `rename_all = "camelCase"` maps Rust's
/// snake_case to the server's camelCase JSON without per-field renames, so a
/// mismatch here is a compile-time visible struct field, not a silent typo
/// in a string literal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterVaultRequest {
    pub client_vault_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub vault_id: String,
    pub name: String,
    pub sync_status: String,
    pub note_count: i64,
    pub last_synced_at: Option<String>,
    pub last_full_scan_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileUpload {
    pub client_file_id: String,
    pub relative_path: String,
    pub content: String,
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileEntry {
    pub client_file_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFileEntry {
    pub client_file_id: String,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteResultStatus {
    Created,
    Updated,
    Unchanged,
    Deleted,
    Moved,
    Missing,
    Conflict,
    Error,
}

/// The per-file outcome of an upload, delete, or move. A batch endpoint
/// always returns 200 with one of these per file rather than failing the
/// whole request — the client is responsible for reading `status` on each
/// entry, not just the HTTP status of the call.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteResult {
    pub client_file_id: String,
    pub status: NoteResultStatus,
    pub revision: Option<i64>,
    #[serde(default)]
    pub server_content_hash: Option<String>,
    #[serde(default)]
    pub server_relative_path: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub client_file_id: String,
    pub relative_path: String,
    pub content_hash: String,
    pub revision: i64,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChangesPage {
    pub changes: Vec<ChangeEntry>,
    pub cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_request_serializes_with_camel_case_keys() {
        let request = RegisterVaultRequest {
            client_vault_id: "vault-local-1".into(),
            name: "My Vault".into(),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["clientVaultId"], "vault-local-1");
        assert_eq!(json["name"], "My Vault");
    }

    #[test]
    fn omits_absent_optional_fields_rather_than_sending_null() {
        let upload = SyncFileUpload {
            client_file_id: "a".into(),
            relative_path: "Note.md".into(),
            content: "# Note".into(),
            content_hash: "hash".into(),
            modified_at: None,
            base_revision: None,
        };
        let json = serde_json::to_value(&upload).unwrap();
        assert!(!json.as_object().unwrap().contains_key("modifiedAt"));
        assert!(!json.as_object().unwrap().contains_key("baseRevision"));
    }

    #[test]
    fn parses_every_note_result_status_the_server_can_send() {
        for (word, expected) in [
            ("created", NoteResultStatus::Created),
            ("updated", NoteResultStatus::Updated),
            ("unchanged", NoteResultStatus::Unchanged),
            ("deleted", NoteResultStatus::Deleted),
            ("moved", NoteResultStatus::Moved),
            ("missing", NoteResultStatus::Missing),
            ("conflict", NoteResultStatus::Conflict),
            ("error", NoteResultStatus::Error),
        ] {
            let json = serde_json::json!({
                "clientFileId": "a",
                "status": word,
                "revision": 1,
            });
            let result: NoteResult = serde_json::from_value(json).unwrap();
            assert_eq!(result.status, expected);
        }
    }

    #[test]
    fn parses_a_conflict_result_carrying_the_servers_current_state() {
        let json = serde_json::json!({
            "clientFileId": "a",
            "status": "conflict",
            "revision": 2,
            "serverContentHash": "deadbeef",
            "serverRelativePath": "Notes/a.md",
        });
        let result: NoteResult = serde_json::from_value(json).unwrap();
        assert_eq!(result.status, NoteResultStatus::Conflict);
        assert_eq!(result.server_content_hash.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn parses_a_changes_page_with_a_null_cursor() {
        let json = serde_json::json!({ "changes": [], "cursor": null });
        let page: ChangesPage = serde_json::from_value(json).unwrap();
        assert!(page.changes.is_empty());
        assert!(page.cursor.is_none());
    }
}
