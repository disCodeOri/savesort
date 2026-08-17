use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::new_debouncer;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::{AppState, SyncPhase};

/// How long a path must be quiet before it is considered settled. This is the
/// coalescing window: a burst of writes from one save collapses into a single
/// wake-up rather than one per raw event.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(750);

/// After the debouncer settles, confirm the file has actually stopped growing
/// before reading it. An editor writing a large note can pause longer than the
/// debounce window mid-write, so the debounce alone is not proof of stability.
const STABILITY_CHECK_DELAY: Duration = Duration::from_millis(250);

fn is_stable(path: &Path) -> bool {
    let Ok(first) = std::fs::metadata(path) else {
        // A missing file is "stable" — the delete path handles it from here.
        return true;
    };
    std::thread::sleep(STABILITY_CHECK_DELAY);
    let Ok(second) = std::fs::metadata(path) else {
        return true;
    };
    first.len() == second.len() && first.modified().ok() == second.modified().ok()
}

/// Watches the vault on a dedicated OS thread and triggers a reconcile+drain
/// whenever something settles.
///
/// The watcher deliberately does not translate individual events into
/// individual queue operations. It only decides *when* to look; the
/// reconciliation diff decides *what* changed by comparing hashes against the
/// manifest. That keeps a duplicated, out-of-order, or entirely missed event
/// from corrupting sync state, and means the watcher and the periodic scan
/// share one correctness path instead of two.
pub fn spawn<R: Runtime>(app: AppHandle<R>, vault_root: PathBuf) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();

        let mut debouncer = match new_debouncer(DEBOUNCE_WINDOW, None, tx) {
            Ok(debouncer) => debouncer,
            Err(error) => {
                tracing::error!(error = %error, "could not start the vault watcher");
                return;
            }
        };

        if let Err(error) = debouncer
            .watcher()
            .watch(&vault_root, RecursiveMode::Recursive)
        {
            tracing::error!(error = %error, "could not watch the vault directory");
            return;
        }

        tracing::info!(vault = %vault_root.display(), "watching vault");

        for result in rx {
            let events = match result {
                Ok(events) => events,
                Err(errors) => {
                    // Watcher errors are recoverable in practice (a folder was
                    // briefly locked, a network drive blipped). The periodic
                    // reconciliation scan is the backstop, so log and continue
                    // rather than tearing the watcher down.
                    for error in errors {
                        tracing::warn!(error = %error, "vault watcher reported an error");
                    }
                    continue;
                }
            };

            let touched_paths: Vec<PathBuf> = events
                .iter()
                .flat_map(|event| event.paths.clone())
                .collect();
            if touched_paths.is_empty() {
                continue;
            }
            if !touched_paths.iter().all(|path| is_stable(path)) {
                // Something is still being written; the next event for it will
                // bring us back here.
                continue;
            }

            trigger_sync(&app);
        }
    });
}

fn trigger_sync<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
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
            return;
        };
        if paused {
            return;
        }

        if let Err(error) = state.engine.reconcile(&vault_path, &rules) {
            tracing::warn!(error = %error, "watcher-triggered reconcile failed");
            return;
        }
        match state.engine.drain_queue(&vault_path, &vault_id, 10_000).await {
            Ok(completed) => {
                if completed > 0 {
                    tracing::info!(completed, "watcher-triggered sync finished");
                }
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
                tracing::warn!(error = %error, "watcher-triggered drain failed");
                state.set_phase(SyncPhase::Offline);
            }
        }
    });
}
