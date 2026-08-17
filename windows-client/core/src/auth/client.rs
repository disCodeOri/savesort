use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::auth::DeviceTokens;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    /// The server rejected the request. `code` is the stable machine-readable
    /// value from the shared sync error envelope (e.g. "unauthenticated").
    #[error("{message}")]
    Rejected { code: String, message: String },
    #[error("the server returned an unexpected response")]
    Decode,
}

#[derive(Debug, Serialize)]
#[serde(tag = "grant_type")]
enum TokenRequest<'a> {
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        code: &'a str,
        code_verifier: &'a str,
        redirect_uri: &'a str,
    },
    #[serde(rename = "refresh_token")]
    RefreshToken { refresh_token: &'a str },
}

#[derive(Debug, Deserialize)]
struct TokenResponseBody {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
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

/// now + `expires_in_seconds`, as RFC3339. Pulled out as a pure function so
/// the expiry math is testable without waiting on a real clock or a network
/// call.
pub fn compute_access_expires_at(now: OffsetDateTime, expires_in_seconds: i64) -> String {
    let expiry = now + time::Duration::seconds(expires_in_seconds);
    expiry
        .format(&Rfc3339)
        .unwrap_or_else(|_| now.format(&Rfc3339).unwrap_or_default())
}

/// Talks to `/api/desktop/token` and `/api/desktop/revoke`. Holds no state of
/// its own — the caller is responsible for persisting the returned tokens via
/// a `TokenStore`.
pub struct DesktopAuthClient {
    http: reqwest::Client,
    base_url: String,
}

impl DesktopAuthClient {
    pub fn new(http: reqwest::Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }

    pub async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<DeviceTokens, AuthError> {
        self.request_token(TokenRequest::AuthorizationCode {
            code,
            code_verifier: verifier,
            redirect_uri,
        })
        .await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<DeviceTokens, AuthError> {
        self.request_token(TokenRequest::RefreshToken { refresh_token })
            .await
    }

    async fn request_token(&self, body: TokenRequest<'_>) -> Result<DeviceTokens, AuthError> {
        let response = self
            .http
            .post(format!("{}/api/desktop/token", self.base_url))
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(rejection_from(response).await);
        }

        let body: TokenResponseBody = response.json().await.map_err(|_| AuthError::Decode)?;
        Ok(DeviceTokens {
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            access_expires_at: compute_access_expires_at(OffsetDateTime::now_utc(), body.expires_in),
        })
    }

    pub async fn revoke(&self, access_token: &str) -> Result<(), AuthError> {
        let response = self
            .http
            .post(format!("{}/api/desktop/revoke", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(rejection_from(response).await);
        }
        Ok(())
    }
}

async fn rejection_from(response: reqwest::Response) -> AuthError {
    match response.json::<ErrorEnvelope>().await {
        Ok(envelope) => AuthError::Rejected {
            code: envelope.error.code,
            message: envelope.error.message,
        },
        Err(_) => AuthError::Decode,
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[test]
    fn computes_expiry_as_now_plus_expires_in() {
        let now = datetime!(2026-08-17 00:00:00 UTC);
        assert_eq!(
            compute_access_expires_at(now, 3_600),
            "2026-08-17T01:00:00Z"
        );
    }

    #[tokio::test]
    async fn exchange_code_sends_the_authorization_code_grant() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/desktop/token"))
            .and(body_json(serde_json::json!({
                "grant_type": "authorization_code",
                "code": "the-code",
                "code_verifier": "the-verifier",
                "redirect_uri": "http://127.0.0.1:5555/callback",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-1",
                "refresh_token": "refresh-1",
                "token_type": "Bearer",
                "expires_in": 3_600,
            })))
            .mount(&server)
            .await;

        let client = DesktopAuthClient::new(reqwest::Client::new(), server.uri());
        let tokens = client
            .exchange_code("the-code", "the-verifier", "http://127.0.0.1:5555/callback")
            .await
            .unwrap();

        assert_eq!(tokens.access_token, "access-1");
        assert_eq!(tokens.refresh_token, "refresh-1");
    }

    #[tokio::test]
    async fn refresh_sends_the_refresh_token_grant() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/desktop/token"))
            .and(body_json(serde_json::json!({
                "grant_type": "refresh_token",
                "refresh_token": "old-refresh",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-2",
                "refresh_token": "refresh-2",
                "token_type": "Bearer",
                "expires_in": 3_600,
            })))
            .mount(&server)
            .await;

        let client = DesktopAuthClient::new(reqwest::Client::new(), server.uri());
        let tokens = client.refresh("old-refresh").await.unwrap();

        assert_eq!(tokens.access_token, "access-2");
    }

    #[tokio::test]
    async fn a_rejected_exchange_surfaces_the_servers_error_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/desktop/token"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": {
                    "code": "unauthenticated",
                    "message": "That sign-in could not be completed.",
                }
            })))
            .mount(&server)
            .await;

        let client = DesktopAuthClient::new(reqwest::Client::new(), server.uri());
        let error = client
            .exchange_code("bad-code", "verifier", "http://127.0.0.1:5555/callback")
            .await
            .unwrap_err();

        match error {
            AuthError::Rejected { code, .. } => assert_eq!(code, "unauthenticated"),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn revoke_sends_the_access_token_as_a_bearer_header() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/desktop/revoke"))
            .and(header("authorization", "Bearer access-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "revoked": true
            })))
            .mount(&server)
            .await;

        let client = DesktopAuthClient::new(reqwest::Client::new(), server.uri());
        client.revoke("access-1").await.unwrap();
    }
}
