use std::path::{Path, PathBuf};
use std::sync::Arc;

use savesort_core::auth::{DesktopAuthClient, TokenStore};
use savesort_core::storage::{FileRecord, Operation, SyncStatus};
use savesort_core::sync::{
    plan_from_scan, process_next, ProcessedOutcome, ReconcileAction, ReqwestSyncApi, SyncApi,
    RegisterVaultRequest,
};
use savesort_core::{scan_vault, ExcludeRules, Storage};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::settings::Settings;
use crate::state::{SyncPhase, SyncStatusSnapshot};

pub struct Engine {
    pub storage: Arc<Storage>,
    pub api: ReqwestSyncApi,
    pub auth: DesktopAuthClient,
    pub tokens: Arc<dyn TokenStore>,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("not signed in")]
    NotSignedIn,
    #[error("{0}")]
    Message(String),
}

fn now_iso() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}

impl Engine {
    /// Returns a valid access token, refreshing it first if it is within the
    /// expiry window. A refresh failure surfaces as `NotSignedIn` so the tray
    /// can prompt the user rather than retrying a dead credential forever.
    pub async fn access_token(&self) -> Result<String, EngineError> {
        let stored = self
            .tokens
            .load()
            .map_err(|error| EngineError::Message(error.to_string()))?
            .ok_or(EngineError::NotSignedIn)?;

        let expires_at = OffsetDateTime::parse(&stored.access_expires_at, &Rfc3339)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH);
        // Refresh a minute early so a token does not expire mid-request.
        if expires_at > OffsetDateTime::now_utc() + time::Duration::seconds(60) {
            return Ok(stored.access_token);
        }

        let refreshed = self
            .auth
            .refresh(&stored.refresh_token)
            .await
            .map_err(|_| EngineError::NotSignedIn)?;
        self.tokens
            .save(&refreshed)
            .map_err(|error| EngineError::Message(error.to_string()))?;
        Ok(refreshed.access_token)
    }

    pub async fn register_vault(
        &self,
        settings: &mut Settings,
        vault_path: PathBuf,
    ) -> Result<String, EngineError> {
        let token = self.access_token().await?;
        let client_vault_id = settings
            .client_vault_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let name = vault_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Obsidian Vault".to_string());

        let summary = self
            .api
            .register_vault(
                &token,
                &RegisterVaultRequest {
                    client_vault_id: client_vault_id.clone(),
                    name,
                },
            )
            .await
            .map_err(|error| EngineError::Message(error.to_string()))?;

        settings.vault_path = Some(vault_path);
        settings.client_vault_id = Some(client_vault_id);
        settings.server_vault_id = Some(summary.vault_id.clone());
        Ok(summary.vault_id)
    }

    /// Walks the vault and queues whatever differs from the local manifest.
    /// Used for both the initial sync and every periodic reconciliation pass —
    /// they are the same operation, which is why a missed filesystem event is
    /// always eventually corrected.
    pub fn reconcile(
        &self,
        vault_root: &Path,
        rules: &ExcludeRules,
    ) -> Result<usize, EngineError> {
        let scan = scan_vault(vault_root, rules)
            .map_err(|error| EngineError::Message(error.to_string()))?;
        let existing = self
            .storage
            .list_all_files()
            .map_err(|error| EngineError::Message(error.to_string()))?;
        let actions = plan_from_scan(&existing, &scan.files);
        let queued = actions.len();

        for action in actions {
            match action {
                ReconcileAction::New {
                    relative_path,
                    content_hash,
                    size_bytes,
                    modified_at,
                } => {
                    let client_file_id = Uuid::new_v4().to_string();
                    self.upsert_record(
                        &client_file_id,
                        &relative_path,
                        &content_hash,
                        size_bytes,
                        &modified_at,
                        None,
                        None,
                    )?;
                    self.enqueue(&client_file_id, Operation::Upsert)?;
                }
                ReconcileAction::Changed {
                    client_file_id,
                    relative_path,
                    content_hash,
                    size_bytes,
                    modified_at,
                } => {
                    let previous = self
                        .storage
                        .get_file(&client_file_id)
                        .map_err(|error| EngineError::Message(error.to_string()))?;
                    self.upsert_record(
                        &client_file_id,
                        &relative_path,
                        &content_hash,
                        size_bytes,
                        &modified_at,
                        previous.as_ref().and_then(|r| r.last_synced_hash.clone()),
                        previous.as_ref().and_then(|r| r.last_synced_revision),
                    )?;
                    self.enqueue(&client_file_id, Operation::Upsert)?;
                }
                ReconcileAction::Moved {
                    client_file_id,
                    to_relative_path,
                    ..
                } => {
                    if let Some(mut record) = self
                        .storage
                        .get_file(&client_file_id)
                        .map_err(|error| EngineError::Message(error.to_string()))?
                    {
                        record.relative_path = to_relative_path;
                        record.sync_status = SyncStatus::Pending;
                        self.storage
                            .upsert_file(&record)
                            .map_err(|error| EngineError::Message(error.to_string()))?;
                    }
                    self.enqueue(&client_file_id, Operation::Move)?;
                }
                ReconcileAction::Deleted { client_file_id } => {
                    self.enqueue(&client_file_id, Operation::Delete)?;
                }
            }
        }

        Ok(queued)
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_record(
        &self,
        client_file_id: &str,
        relative_path: &str,
        content_hash: &str,
        size_bytes: i64,
        modified_at: &str,
        last_synced_hash: Option<String>,
        last_synced_revision: Option<i64>,
    ) -> Result<(), EngineError> {
        self.storage
            .upsert_file(&FileRecord {
                client_file_id: client_file_id.to_string(),
                relative_path: relative_path.to_string(),
                content_hash: content_hash.to_string(),
                size_bytes,
                modified_at: modified_at.to_string(),
                last_synced_hash,
                last_synced_revision,
                sync_status: SyncStatus::Pending,
                last_error: None,
            })
            .map_err(|error| EngineError::Message(error.to_string()))
    }

    fn enqueue(&self, client_file_id: &str, operation: Operation) -> Result<(), EngineError> {
        self.storage
            .enqueue(client_file_id, operation, None, &now_iso())
            .map(|_| ())
            .map_err(|error| EngineError::Message(error.to_string()))
    }

    /// Drains the queue until it is empty or something asks us to stop.
    /// Returns how many operations completed successfully.
    pub async fn drain_queue(
        &self,
        vault_root: &Path,
        vault_id: &str,
        max_operations: usize,
    ) -> Result<usize, EngineError> {
        let mut token = self.access_token().await?;
        let mut completed = 0usize;

        for _ in 0..max_operations {
            let lease_id = Uuid::new_v4().to_string();
            let outcome = process_next(
                &self.storage,
                &self.api,
                vault_root,
                vault_id,
                &token,
                &lease_id,
                OffsetDateTime::now_utc(),
            )
            .await
            .map_err(|error| EngineError::Message(error.to_string()))?;

            match outcome {
                None => break,
                Some(ProcessedOutcome::Synced) => completed += 1,
                Some(ProcessedOutcome::Conflict { .. }) => {}
                Some(ProcessedOutcome::RetryScheduled { .. }) => break,
                Some(ProcessedOutcome::ReauthRequired) => {
                    // Refresh once and continue; if it fails, access_token
                    // surfaces NotSignedIn and the loop ends.
                    token = self.access_token().await?;
                }
            }
        }

        Ok(completed)
    }

    pub fn snapshot(&self, settings: &Settings, phase: SyncPhase) -> SyncStatusSnapshot {
        let counts = self.storage.queue_counts().unwrap_or_default();
        let files = self.storage.list_all_files().unwrap_or_default();
        SyncStatusSnapshot {
            phase,
            pending_operations: counts.queued + counts.leased,
            synced_notes: files
                .iter()
                .filter(|f| f.sync_status == SyncStatus::Synced)
                .count() as i64,
            conflicts: files
                .iter()
                .filter(|f| f.sync_status == SyncStatus::Conflict)
                .count() as i64,
            errors: files
                .iter()
                .filter(|f| f.sync_status == SyncStatus::Error)
                .count() as i64,
            vault_path: settings
                .vault_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            paused: settings.paused,
        }
    }
}
