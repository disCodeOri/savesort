use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
#[error("device credentials could not be stored: {0}")]
pub struct TokenStoreError(pub String);

/// The device's current token pair. `access_expires_at` is computed
/// client-side (now + `expires_in`) at the moment the tokens are issued.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub access_expires_at: String,
}

/// Where device credentials live. The real implementation (Windows
/// Credential Manager, via the `keyring` crate) is in the Tauri shell, not
/// here — this crate stays free of that OS-specific dependency so it keeps
/// compiling in seconds. `InMemoryTokenStore` below is a real, usable
/// implementation in its own right for tests and for any host that doesn't
/// need OS-backed storage.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> Result<Option<DeviceTokens>, TokenStoreError>;
    fn save(&self, tokens: &DeviceTokens) -> Result<(), TokenStoreError>;
    fn clear(&self) -> Result<(), TokenStoreError>;
}

#[derive(Default)]
pub struct InMemoryTokenStore {
    tokens: Mutex<Option<DeviceTokens>>,
}

impl InMemoryTokenStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl TokenStore for InMemoryTokenStore {
    fn load(&self) -> Result<Option<DeviceTokens>, TokenStoreError> {
        Ok(self.tokens.lock().expect("token store mutex poisoned").clone())
    }

    fn save(&self, tokens: &DeviceTokens) -> Result<(), TokenStoreError> {
        *self.tokens.lock().expect("token store mutex poisoned") = Some(tokens.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), TokenStoreError> {
        *self.tokens.lock().expect("token store mutex poisoned") = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DeviceTokens {
        DeviceTokens {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            access_expires_at: "2026-08-17T01:00:00Z".into(),
        }
    }

    #[test]
    fn starts_empty() {
        let store = InMemoryTokenStore::new();
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn round_trips_saved_tokens() {
        let store = InMemoryTokenStore::new();
        store.save(&sample()).unwrap();
        assert_eq!(store.load().unwrap(), Some(sample()));
    }

    #[test]
    fn save_overwrites_the_previous_tokens() {
        let store = InMemoryTokenStore::new();
        store.save(&sample()).unwrap();
        let rotated = DeviceTokens {
            access_token: "rotated".into(),
            ..sample()
        };
        store.save(&rotated).unwrap();
        assert_eq!(store.load().unwrap().unwrap().access_token, "rotated");
    }

    #[test]
    fn clear_removes_stored_tokens() {
        let store = InMemoryTokenStore::new();
        store.save(&sample()).unwrap();
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}
