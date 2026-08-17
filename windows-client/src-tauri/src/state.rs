use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::engine::Engine;
use crate::settings::Settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase {
    NotSignedIn,
    NoVault,
    InitialSync,
    Syncing,
    Synced,
    Offline,
    Paused,
    AttentionRequired,
}

impl SyncPhase {
    /// The short label shown in the tray tooltip and menu header.
    pub fn label(self) -> &'static str {
        match self {
            SyncPhase::NotSignedIn => "Sign in required",
            SyncPhase::NoVault => "Choose a vault",
            SyncPhase::InitialSync => "Initial sync…",
            SyncPhase::Syncing => "Syncing…",
            SyncPhase::Synced => "Synced",
            SyncPhase::Offline => "Offline",
            SyncPhase::Paused => "Paused",
            SyncPhase::AttentionRequired => "Attention required",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusSnapshot {
    pub phase: SyncPhase,
    pub pending_operations: i64,
    pub synced_notes: i64,
    pub conflicts: i64,
    pub errors: i64,
    pub vault_path: Option<String>,
    pub paused: bool,
}

pub struct AppState {
    pub engine: Arc<Engine>,
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub phase: Mutex<SyncPhase>,
}

impl AppState {
    pub fn current_phase(&self) -> SyncPhase {
        *self.phase.lock().expect("phase mutex poisoned")
    }

    pub fn set_phase(&self, phase: SyncPhase) {
        *self.phase.lock().expect("phase mutex poisoned") = phase;
    }

    pub fn snapshot(&self) -> SyncStatusSnapshot {
        let settings = self.settings.lock().expect("settings mutex poisoned");
        self.engine.snapshot(&settings, self.current_phase())
    }

    pub fn persist_settings(&self) {
        let settings = self.settings.lock().expect("settings mutex poisoned");
        if let Err(error) = settings.save(&self.settings_path) {
            tracing::error!(error = %error, "could not save settings");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_phase_has_a_human_readable_label() {
        for phase in [
            SyncPhase::NotSignedIn,
            SyncPhase::NoVault,
            SyncPhase::InitialSync,
            SyncPhase::Syncing,
            SyncPhase::Synced,
            SyncPhase::Offline,
            SyncPhase::Paused,
            SyncPhase::AttentionRequired,
        ] {
            assert!(!phase.label().is_empty());
        }
    }

    #[test]
    fn phase_serializes_as_snake_case_for_the_frontend() {
        let json = serde_json::to_string(&SyncPhase::AttentionRequired).unwrap();
        assert_eq!(json, "\"attention_required\"");
    }
}
