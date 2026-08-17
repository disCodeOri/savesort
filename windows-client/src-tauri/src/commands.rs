use std::path::PathBuf;

use tauri::State;

use crate::auth_flow::run_loopback_authorization;
use crate::state::{AppState, SyncPhase, SyncStatusSnapshot};

/// Every command returns `Result<_, String>` because Tauri serializes the
/// error straight to the frontend. Messages here are user-facing and must
/// never contain note contents or tokens.
type CommandResult<T> = Result<T, String>;

#[tauri::command]
pub fn get_status(state: State<'_, AppState>) -> SyncStatusSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn is_signed_in(state: State<'_, AppState>) -> bool {
    state
        .engine
        .tokens
        .load()
        .ok()
        .flatten()
        .is_some()
}

/// The base URL is resolved here rather than accepted from the frontend, so
/// SAVESORT_BASE_URL governs every network path and the UI cannot send a
/// sign-in somewhere the sync engine will not talk to.
#[tauri::command]
pub async fn sign_in(state: State<'_, AppState>) -> CommandResult<bool> {
    let device_name = hostname_or_default();
    let base_url = crate::resolved_base_url();
    let tokens = run_loopback_authorization(base_url, device_name, reqwest::Client::new())
        .await
        .map_err(|error| error.to_string())?;

    state
        .engine
        .tokens
        .save(&tokens)
        .map_err(|error| error.to_string())?;

    let has_vault = state
        .settings
        .lock()
        .expect("settings mutex poisoned")
        .vault_path
        .is_some();
    state.set_phase(if has_vault {
        SyncPhase::Syncing
    } else {
        SyncPhase::NoVault
    });
    Ok(true)
}

#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>) -> CommandResult<()> {
    // Revoke server-side first so a lost machine stops syncing even if the
    // local clear fails; a failed revoke should still clear locally.
    if let Ok(Some(tokens)) = state.engine.tokens.load() {
        let _ = state.engine.auth.revoke(&tokens.access_token).await;
    }
    state
        .engine
        .tokens
        .clear()
        .map_err(|error| error.to_string())?;
    state.set_phase(SyncPhase::NotSignedIn);
    Ok(())
}

#[tauri::command]
pub async fn select_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CommandResult<String> {
    let vault_path = PathBuf::from(&path);
    if !vault_path.is_dir() {
        return Err("That folder could not be opened.".into());
    }

    let mut settings = state
        .settings
        .lock()
        .expect("settings mutex poisoned")
        .clone();
    let vault_id = state
        .engine
        .register_vault(&mut settings, vault_path.clone())
        .await
        .map_err(|error| error.to_string())?;

    *state.settings.lock().expect("settings mutex poisoned") = settings;
    state.persist_settings();
    state.set_phase(SyncPhase::InitialSync);

    // Watch immediately so edits during the initial sync are not missed.
    crate::watch::spawn(app, vault_path);
    Ok(vault_id)
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CommandResult<i64> {
    let (vault_path, vault_id, rules, paused) = {
        let settings = state.settings.lock().expect("settings mutex poisoned");
        (
            settings.vault_path.clone(),
            settings.server_vault_id.clone(),
            settings.exclude_rules(),
            settings.paused,
        )
    };

    if paused {
        return Err("Sync is paused.".into());
    }
    let vault_path = vault_path.ok_or("Choose an Obsidian vault first.")?;
    let vault_id = vault_id.ok_or("Choose an Obsidian vault first.")?;

    state.set_phase(SyncPhase::Syncing);
    state
        .engine
        .reconcile(&vault_path, &rules)
        .map_err(|error| error.to_string())?;
    let completed = state
        .engine
        .drain_queue(&vault_path, &vault_id, 10_000)
        .await
        .map_err(|error| error.to_string())?;

    let snapshot = state.snapshot();
    state.set_phase(if snapshot.conflicts > 0 || snapshot.errors > 0 {
        SyncPhase::AttentionRequired
    } else if snapshot.pending_operations > 0 {
        SyncPhase::Syncing
    } else {
        SyncPhase::Synced
    });

    Ok(completed as i64)
}

#[tauri::command]
pub fn set_paused(state: State<'_, AppState>, paused: bool) -> CommandResult<()> {
    state
        .settings
        .lock()
        .expect("settings mutex poisoned")
        .paused = paused;
    state.persist_settings();
    state.set_phase(if paused {
        SyncPhase::Paused
    } else {
        SyncPhase::Syncing
    });
    Ok(())
}

#[tauri::command]
pub fn get_log_directory(state: State<'_, AppState>) -> String {
    state
        .settings_path
        .parent()
        .map(|dir| dir.join("logs").to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Windows PC".to_string())
}
