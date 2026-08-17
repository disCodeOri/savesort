use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;
use sha2::{Digest, Sha256};

fn random_base64url(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A CSRF token for the `/desktop/authorize` request, compared against what
/// the loopback callback receives before any code is trusted.
pub fn generate_state() -> String {
    random_base64url(32)
}

pub struct PkceChallenge {
    pub verifier: String,
    /// RFC 7636 S256: base64url(sha256(verifier)). Sent in the authorize
    /// request; the verifier itself is sent only at the token exchange, so a
    /// party that intercepts the authorize redirect cannot redeem the code.
    pub challenge: String,
}

pub fn generate_pkce_challenge() -> PkceChallenge {
    let verifier = random_base64url(32);
    let challenge = challenge_for_verifier(&verifier);
    PkceChallenge { verifier, challenge }
}

fn challenge_for_verifier(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_the_base64url_sha256_of_the_verifier() {
        let generated = generate_pkce_challenge();
        assert_eq!(
            generated.challenge,
            challenge_for_verifier(&generated.verifier)
        );
    }

    #[test]
    fn verifier_length_satisfies_rfc_7636() {
        // RFC 7636 requires a 43-128 character verifier; 32 random bytes
        // base64url-encoded (no padding) is 43 characters.
        let generated = generate_pkce_challenge();
        assert!(generated.verifier.len() >= 43 && generated.verifier.len() <= 128);
    }

    #[test]
    fn two_calls_produce_different_verifiers() {
        let a = generate_pkce_challenge();
        let b = generate_pkce_challenge();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn state_values_are_long_and_unique() {
        let a = generate_state();
        let b = generate_state();
        assert!(a.len() >= 32);
        assert_ne!(a, b);
    }
}
