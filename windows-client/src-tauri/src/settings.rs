use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use savesort_core::ExcludeRules;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub vault_path: Option<PathBuf>,
    pub client_vault_id: Option<String>,
    pub server_vault_id: Option<String>,
    pub excluded_dir_names: Vec<String>,
    pub excluded_name_suffixes: Vec<String>,
    pub paused: bool,
    pub run_at_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let defaults = ExcludeRules::default();
        Self {
            vault_path: None,
            client_vault_id: None,
            server_vault_id: None,
            excluded_dir_names: defaults.excluded_dir_names,
            excluded_name_suffixes: defaults.excluded_name_suffixes,
            paused: false,
            run_at_startup: true,
        }
    }
}

impl Settings {
    pub fn exclude_rules(&self) -> ExcludeRules {
        ExcludeRules {
            excluded_dir_names: self.excluded_dir_names.clone(),
            excluded_name_suffixes: self.excluded_name_suffixes.clone(),
        }
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        std::fs::write(path, json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_documented_exclusion_list() {
        let settings = Settings::default();
        assert!(settings.excluded_dir_names.contains(&".obsidian".to_string()));
        assert!(settings.excluded_dir_names.contains(&".trash".to_string()));
        assert!(settings.run_at_startup);
        assert!(!settings.paused);
    }

    #[test]
    fn load_falls_back_to_defaults_when_the_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::load(&dir.path().join("does-not-exist.json"));
        assert!(settings.vault_path.is_none());
    }

    #[test]
    fn save_then_load_round_trips_custom_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let mut settings = Settings {
            vault_path: Some(PathBuf::from(r"C:\Users\me\Vault")),
            paused: true,
            ..Settings::default()
        };
        settings.excluded_dir_names.push("Templates".into());
        settings.save(&path).unwrap();

        let reloaded = Settings::load(&path);
        assert_eq!(reloaded.vault_path, settings.vault_path);
        assert!(reloaded.paused);
        assert!(reloaded.excluded_dir_names.contains(&"Templates".to_string()));
    }
}
