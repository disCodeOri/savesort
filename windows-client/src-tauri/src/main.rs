// Hide the console window in release; keep it in debug for log visibility.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth_flow;
mod commands;
mod engine;
mod keyring_store;
mod logging;
mod settings;
mod state;
mod tray;
mod watch;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use savesort_core::auth::{DesktopAuthClient, TokenStore};
use savesort_core::sync::ReqwestSyncApi;
use savesort_core::Storage;
use tauri::{Manager, WindowEvent};

use crate::engine::Engine;
use crate::keyring_store::KeyringTokenStore;
use crate::settings::Settings;
use crate::state::{AppState, SyncPhase};

/// How often the reconciliation scan runs. Filesystem events are the fast
/// path; this is the safety net that catches whatever they missed.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(300);

/// The deployed web app. Overridable with SAVESORT_BASE_URL for local
/// development against a dev server.
pub const DEFAULT_BASE_URL: &str = "https://grapplin.vercel.app";

pub fn resolved_base_url() -> String {
    let configured =
        std::env::var("SAVESORT_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
    // Refuse plaintext except against a loopback dev server, so a
    // misconfigured environment variable cannot silently send notes over
    // an unencrypted connection.
    if configured.starts_with("https://")
        || configured.starts_with("http://127.0.0.1")
        || configured.starts_with("http://localhost")
    {
        configured
    } else {
        eprintln!("SAVESORT_BASE_URL must use https; falling back to the default");
        DEFAULT_BASE_URL.to_string()
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::is_signed_in,
            commands::sign_in,
            commands::sign_out,
            commands::select_vault,
            commands::sync_now,
            commands::set_paused,
            commands::get_log_directory,
        ])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("an app data directory should be available");
            std::fs::create_dir_all(&app_data_dir)?;

            let guard = logging::init(&logging::log_dir(&app_data_dir));
            // Held for the process lifetime so buffered logs are flushed.
            if let Some(guard) = guard {
                app.manage(guard);
            }

            let settings_path = app_data_dir.join("settings.json");
            let settings = Settings::load(&settings_path);
            let watched_vault = settings.vault_path.clone();
            let storage = Arc::new(Storage::open(&app_data_dir.join("sync.sqlite3"))?);

            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .expect("a default HTTP client should build");
            let tokens: Arc<dyn TokenStore> = Arc::new(KeyringTokenStore);
            let engine = Arc::new(Engine {
                storage,
                api: ReqwestSyncApi::new(http.clone(), resolved_base_url()),
                auth: DesktopAuthClient::new(http, resolved_base_url()),
                tokens: tokens.clone(),
            });

            let signed_in = tokens.load().ok().flatten().is_some();
            let phase = if !signed_in {
                SyncPhase::NotSignedIn
            } else if settings.vault_path.is_none() {
                SyncPhase::NoVault
            } else if settings.paused {
                SyncPhase::Paused
            } else {
                SyncPhase::Syncing
            };

            app.manage(AppState {
                engine: engine.clone(),
                settings: Mutex::new(settings),
                settings_path,
                phase: Mutex::new(phase),
            });

            tray::create(app.handle())?;

            // Start watching immediately if a vault was already chosen in a
            // previous run, so the user never has to re-trigger anything.
            if let Some(vault_path) = watched_vault {
                if vault_path.is_dir() {
                    watch::spawn(app.handle().clone(), vault_path);
                }
            }

            // Background reconciliation loop. Deliberately started even when
            // signed out — it simply finds nothing to do until the user
            // connects, which avoids a separate "start syncing" trigger.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(RECONCILE_INTERVAL).await;
                    let state = handle.state::<AppState>();
                    let (vault_path, vault_id, rules, paused) = {
                        let settings = state.settings.lock().expect("settings mutex poisoned");
                        (
                            settings.vault_path.clone(),
                            settings.server_vault_id.clone(),
                            settings.exclude_rules(),
                            settings.paused,
                        )
                    };
                    let (Some(vault_path), Some(vault_id)) = (vault_path, vault_id) else {
                        continue;
                    };
                    if paused {
                        continue;
                    }

                    if let Err(error) = state.engine.reconcile(&vault_path, &rules) {
                        tracing::warn!(error = %error, "reconciliation scan failed");
                        continue;
                    }
                    match state.engine.drain_queue(&vault_path, &vault_id, 10_000).await {
                        Ok(count) => {
                            tracing::info!(completed = count, "reconciliation drain finished");
                            let snapshot = state.snapshot();
                            state.set_phase(if snapshot.conflicts > 0 || snapshot.errors > 0 {
                                SyncPhase::AttentionRequired
                            } else if snapshot.pending_operations > 0 {
                                SyncPhase::Syncing
                            } else {
                                SyncPhase::Synced
                            });
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "queue drain failed");
                            state.set_phase(SyncPhase::Offline);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the dashboard hides it rather than quitting: this is a
            // background sync utility, and quitting is an explicit tray action.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SaveSort Desktop");
}
