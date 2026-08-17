use keyring::Entry;
use savesort_core::auth::{DeviceTokens, TokenStore, TokenStoreError};

const SERVICE: &str = "SaveSort Desktop";
const ACCOUNT: &str = "device-tokens";

/// Stores the device's token pair in Windows Credential Manager via the
/// `keyring` crate. Tokens never touch a plaintext file — this is the only
/// place they exist outside process memory.
pub struct KeyringTokenStore;

impl KeyringTokenStore {
    fn entry(&self) -> Result<Entry, TokenStoreError> {
        Entry::new(SERVICE, ACCOUNT).map_err(|error| TokenStoreError(error.to_string()))
    }
}

impl TokenStore for KeyringTokenStore {
    fn load(&self) -> Result<Option<DeviceTokens>, TokenStoreError> {
        let entry = self.entry()?;
        match entry.get_password() {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|error| TokenStoreError(error.to_string())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(TokenStoreError(error.to_string())),
        }
    }

    fn save(&self, tokens: &DeviceTokens) -> Result<(), TokenStoreError> {
        let entry = self.entry()?;
        let json = serde_json::to_string(tokens).map_err(|error| TokenStoreError(error.to_string()))?;
        entry
            .set_password(&json)
            .map_err(|error| TokenStoreError(error.to_string()))
    }

    fn clear(&self) -> Result<(), TokenStoreError> {
        let entry = self.entry()?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(TokenStoreError(error.to_string())),
        }
    }
}

// This is deliberately not covered by an automated test here: it talks to
// the real Windows Credential Manager, which requires an interactive desktop
// session and would leave a stray credential behind in CI. `TokenStore` is
// the trait boundary that lets the rest of the auth flow be tested against
// `InMemoryTokenStore` instead; verify this implementation by hand with
// `cargo run` and checking Credential Manager for a "SaveSort Desktop" entry.
