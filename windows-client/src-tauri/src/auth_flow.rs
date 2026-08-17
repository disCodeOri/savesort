use std::time::Duration;

use savesort_core::auth::{generate_pkce_challenge, generate_state, AuthError, DesktopAuthClient, DeviceTokens};
use url::Url;

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum AuthFlowError {
    #[error("could not start the local sign-in listener: {0}")]
    Listener(std::io::Error),
    #[error("could not open a browser: {0}")]
    Browser(std::io::Error),
    #[error("sign-in timed out")]
    Timeout,
    #[error("sign-in response did not match what was requested")]
    StateMismatch,
    #[error("sign-in was cancelled")]
    MissingCode,
    #[error("sign-in could not be completed: {0}")]
    Exchange(#[from] AuthError),
}

const CALLBACK_PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>SaveSort</title></head><body style=\"font-family:sans-serif;padding:40px;text-align:center\"><h1>You're connected</h1><p>You can close this window and return to SaveSort.</p></body></html>";

/// Runs one browser-based sign-in: opens the system browser to
/// `/desktop/authorize`, waits on a one-shot loopback listener for the
/// redirect, and exchanges the resulting code for a token pair. Blocking I/O
/// runs on a dedicated OS thread so it never stalls the async runtime.
pub async fn run_loopback_authorization(
    base_url: String,
    device_name: String,
    http: reqwest::Client,
) -> Result<DeviceTokens, AuthFlowError> {
    let pkce = generate_pkce_challenge();
    let state = generate_state();

    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(AuthFlowError::Listener)?;
    let port = listener.local_addr().map_err(AuthFlowError::Listener)?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let mut authorize_url =
        Url::parse(&format!("{base_url}/desktop/authorize")).map_err(|error| {
            AuthFlowError::Listener(std::io::Error::new(std::io::ErrorKind::InvalidInput, error))
        })?;
    authorize_url
        .query_pairs_mut()
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("state", &state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("device_name", &device_name);

    webbrowser::open(authorize_url.as_str()).map_err(AuthFlowError::Browser)?;

    let expected_state = state.clone();
    let (code, verifier) = tokio::task::spawn_blocking(move || -> Result<(String, String), AuthFlowError> {
        let server = tiny_http::Server::from_listener(listener, None)
            .map_err(|error| AuthFlowError::Listener(std::io::Error::other(error)))?;
        let request = server
            .recv_timeout(CALLBACK_TIMEOUT)
            .map_err(|error| AuthFlowError::Listener(std::io::Error::other(error)))?
            .ok_or(AuthFlowError::Timeout)?;

        // Any path/query works here — only the query string matters, and the
        // host is ignored, so a dummy base is enough to parse it as a URL.
        let parsed = Url::parse(&format!("http://127.0.0.1{}", request.url())).map_err(|error| {
            AuthFlowError::Listener(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        })?;
        let params: std::collections::HashMap<String, String> =
            parsed.query_pairs().into_owned().collect();

        let response = tiny_http::Response::from_string(CALLBACK_PAGE).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                .expect("static header is well-formed"),
        );
        let _ = request.respond(response);

        if params.get("state").map(String::as_str) != Some(expected_state.as_str()) {
            return Err(AuthFlowError::StateMismatch);
        }
        let code = params.get("code").cloned().ok_or(AuthFlowError::MissingCode)?;
        Ok((code, pkce.verifier))
    })
    .await
    .expect("the loopback listener task should not panic")?;

    let client = DesktopAuthClient::new(http, base_url);
    Ok(client.exchange_code(&code, &verifier, &redirect_uri).await?)
}
