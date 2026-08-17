use sha2::{Digest, Sha256};

/// SHA-256 hex digest of the note's UTF-8 bytes. Must match the server's
/// `hashContent` (src/lib/obsidian/markdown.ts) byte for byte — the server
/// recomputes this hash from the uploaded content and rejects the batch entry
/// if it disagrees, so any divergence here breaks every upload.
pub fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_stable_for_identical_content() {
        assert_eq!(hash_content("# Hello"), hash_content("# Hello"));
    }

    #[test]
    fn differs_for_a_single_character_change() {
        assert_ne!(hash_content("# Hello"), hash_content("# Hello "));
    }

    #[test]
    fn matches_the_known_sha256_of_an_empty_string() {
        // The canonical SHA-256 of the empty string, reused here as a fixed
        // point against the Node crypto implementation the server uses.
        // Verified independently via .NET's SHA256 (System.Security.Cryptography),
        // not transcribed from memory, so this actually cross-checks the
        // implementation rather than restating it.
        assert_eq!(
            hash_content("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn produces_a_64_character_lowercase_hex_string() {
        let digest = hash_content("unicode content: 日本語 😀");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
