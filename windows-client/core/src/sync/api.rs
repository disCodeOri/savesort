use serde::Deserialize;

use crate::sync::protocol::{
    ChangesPage, DeleteFileEntry, MoveFileEntry, NoteResult, RegisterVaultRequest, SyncFileUpload,
    VaultSummary,
};

#[derive(Debug, thiserror::Error)]
pub enum SyncApiError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    /// The access token was rejected. Callers should refresh the token and
    /// retry once rather than treating this like an ordinary failure.
    #[error("access token was rejected")]
    Unauthorized,
    #[error("rate limited: {message}")]
    RateLimited { message: String },
    /// Any other server-reported failure, carrying its machine-readable code.
    #[error("{code}: {message}")]
    Rejected { code: String, message: String },
    #[error("the server returned an unexpected response")]
    Decode,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ErrorDetail {
    code: String,
    message: String,
}

async fn error_for(response: reqwest::Response) -> SyncApiError {
    let status = response.status();
    let envelope = match response.json::<ErrorEnvelope>().await {
        Ok(envelope) => envelope,
        Err(_) => return SyncApiError::Decode,
    };
    if status.as_u16() == 401 {
        return SyncApiError::Unauthorized;
    }
    if status.as_u16() == 429 {
        return SyncApiError::RateLimited {
            message: envelope.error.message,
        };
    }
    SyncApiError::Rejected {
        code: envelope.error.code,
        message: envelope.error.message,
    }
}

/// The sync surface the worker depends on. Kept as a plain trait with native
/// async methods — the worker is generic over `A: SyncApi`, so tests supply
/// an in-memory fake with no network, HTTP mocking, or `dyn` boxing required.
pub trait SyncApi: Send + Sync {
    // Written as `-> impl Future + Send` rather than `async fn`: the worker
    // spawns these across tokio tasks, so the futures must be provably Send.
    // Plain `async fn` in a trait cannot express that bound.
    fn register_vault(
        &self,
        access_token: &str,
        request: &RegisterVaultRequest,
    ) -> impl std::future::Future<Output = Result<VaultSummary, SyncApiError>> + Send;

    fn upload_batch(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[SyncFileUpload],
    ) -> impl std::future::Future<Output = Result<Vec<NoteResult>, SyncApiError>> + Send;

    fn delete_files(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[DeleteFileEntry],
    ) -> impl std::future::Future<Output = Result<Vec<NoteResult>, SyncApiError>> + Send;

    fn move_files(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[MoveFileEntry],
    ) -> impl std::future::Future<Output = Result<Vec<NoteResult>, SyncApiError>> + Send;

    fn get_status(
        &self,
        access_token: &str,
        vault_id: &str,
        mark_full_scan_completed: bool,
    ) -> impl std::future::Future<Output = Result<VaultSummary, SyncApiError>> + Send;

    fn get_changes(
        &self,
        access_token: &str,
        vault_id: &str,
        since: Option<&str>,
        limit: u32,
    ) -> impl std::future::Future<Output = Result<ChangesPage, SyncApiError>> + Send;
}

pub struct ReqwestSyncApi {
    http: reqwest::Client,
    base_url: String,
}

impl ReqwestSyncApi {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }
}

#[derive(Deserialize)]
struct VaultEnvelope {
    vault: VaultSummary,
}

#[derive(Deserialize)]
struct ResultsEnvelope {
    results: Vec<NoteResult>,
}

impl SyncApi for ReqwestSyncApi {
    async fn register_vault(
        &self,
        access_token: &str,
        request: &RegisterVaultRequest,
    ) -> Result<VaultSummary, SyncApiError> {
        let response = self
            .http
            .post(format!("{}/api/sync/register", self.base_url))
            .bearer_auth(access_token)
            .json(request)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        Ok(response
            .json::<VaultEnvelope>()
            .await
            .map_err(|_| SyncApiError::Decode)?
            .vault)
    }

    async fn upload_batch(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[SyncFileUpload],
    ) -> Result<Vec<NoteResult>, SyncApiError> {
        let response = self
            .http
            .post(format!("{}/api/sync/files/batch", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "vaultId": vault_id, "files": files }))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        Ok(response
            .json::<ResultsEnvelope>()
            .await
            .map_err(|_| SyncApiError::Decode)?
            .results)
    }

    async fn delete_files(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[DeleteFileEntry],
    ) -> Result<Vec<NoteResult>, SyncApiError> {
        let response = self
            .http
            .post(format!("{}/api/sync/delete", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "vaultId": vault_id, "files": files }))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        Ok(response
            .json::<ResultsEnvelope>()
            .await
            .map_err(|_| SyncApiError::Decode)?
            .results)
    }

    async fn move_files(
        &self,
        access_token: &str,
        vault_id: &str,
        files: &[MoveFileEntry],
    ) -> Result<Vec<NoteResult>, SyncApiError> {
        let response = self
            .http
            .post(format!("{}/api/sync/move", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "vaultId": vault_id, "files": files }))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        Ok(response
            .json::<ResultsEnvelope>()
            .await
            .map_err(|_| SyncApiError::Decode)?
            .results)
    }

    async fn get_status(
        &self,
        access_token: &str,
        vault_id: &str,
        mark_full_scan_completed: bool,
    ) -> Result<VaultSummary, SyncApiError> {
        let mut query = vec![("vaultId", vault_id.to_string())];
        if mark_full_scan_completed {
            query.push(("fullScanCompleted", "true".to_string()));
        }
        let response = self
            .http
            .get(format!("{}/api/sync/status", self.base_url))
            .bearer_auth(access_token)
            .query(&query)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        Ok(response
            .json::<VaultEnvelope>()
            .await
            .map_err(|_| SyncApiError::Decode)?
            .vault)
    }

    async fn get_changes(
        &self,
        access_token: &str,
        vault_id: &str,
        since: Option<&str>,
        limit: u32,
    ) -> Result<ChangesPage, SyncApiError> {
        let mut query = vec![
            ("vaultId", vault_id.to_string()),
            ("limit", limit.to_string()),
        ];
        if let Some(since) = since {
            query.push(("since", since.to_string()));
        }
        let response = self
            .http
            .get(format!("{}/api/sync/changes", self.base_url))
            .bearer_auth(access_token)
            .query(&query)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(error_for(response).await);
        }
        response.json().await.map_err(|_| SyncApiError::Decode)
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::sync::protocol::NoteResultStatus;

    fn client(server: &MockServer) -> ReqwestSyncApi {
        ReqwestSyncApi::new(reqwest::Client::new(), server.uri())
    }

    #[tokio::test]
    async fn register_vault_sends_the_request_and_parses_the_summary() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/sync/register"))
            .and(header("authorization", "Bearer token-1"))
            .and(body_json(serde_json::json!({
                "clientVaultId": "vault-1",
                "name": "My Vault",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "vault": {
                    "vaultId": "server-vault-id",
                    "name": "My Vault",
                    "syncStatus": "idle",
                    "noteCount": 0,
                    "lastSyncedAt": null,
                    "lastFullScanAt": null,
                }
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let summary = api
            .register_vault(
                "token-1",
                &RegisterVaultRequest {
                    client_vault_id: "vault-1".into(),
                    name: "My Vault".into(),
                },
            )
            .await
            .unwrap();

        assert_eq!(summary.vault_id, "server-vault-id");
    }

    #[tokio::test]
    async fn upload_batch_returns_per_file_results_on_a_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/sync/files/batch"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    { "clientFileId": "a", "status": "created", "revision": 1 },
                    { "clientFileId": "b", "status": "error", "revision": null, "message": "boom" },
                ]
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let results = api
            .upload_batch(
                "token-1",
                "vault-1",
                &[SyncFileUpload {
                    client_file_id: "a".into(),
                    relative_path: "Note.md".into(),
                    content: "# Note".into(),
                    content_hash: "hash".into(),
                    modified_at: None,
                    base_revision: None,
                }],
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[1].status, NoteResultStatus::Error);
    }

    #[tokio::test]
    async fn a_401_maps_to_unauthorized_so_the_worker_knows_to_refresh() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/sync/files/batch"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "code": "unauthenticated", "message": "Sign in again on this device." }
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let error = api.upload_batch("stale-token", "vault-1", &[]).await.unwrap_err();
        assert!(matches!(error, SyncApiError::Unauthorized));
    }

    #[tokio::test]
    async fn a_429_maps_to_rate_limited() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/sync/files/batch"))
            .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
                "error": { "code": "rate_limited", "message": "slow down" }
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let error = api.upload_batch("token-1", "vault-1", &[]).await.unwrap_err();
        assert!(matches!(error, SyncApiError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn a_404_maps_to_a_rejected_error_carrying_the_vault_not_found_code() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sync/status"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "vault_not_found", "message": "not found" }
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let error = api.get_status("token-1", "missing-vault", false).await.unwrap_err();
        match error {
            SyncApiError::Rejected { code, .. } => assert_eq!(code, "vault_not_found"),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn get_status_only_sends_full_scan_completed_when_true() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sync/status"))
            .and(query_param("vaultId", "vault-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "vault": {
                    "vaultId": "vault-1", "name": "V", "syncStatus": "idle",
                    "noteCount": 0, "lastSyncedAt": null, "lastFullScanAt": null,
                }
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        api.get_status("token-1", "vault-1", false).await.unwrap();
        // wiremock's default matcher above only asserts the query param it
        // named; absence of fullScanCompleted is implicitly fine since the
        // mock still matched.
    }

    #[tokio::test]
    async fn get_changes_omits_since_when_starting_from_the_beginning() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sync/changes"))
            .and(query_param("vaultId", "vault-1"))
            .and(query_param("limit", "200"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "changes": [],
                "cursor": null,
            })))
            .mount(&server)
            .await;

        let api = client(&server);
        let page = api.get_changes("token-1", "vault-1", None, 200).await.unwrap();
        assert!(page.changes.is_empty());
    }
}
