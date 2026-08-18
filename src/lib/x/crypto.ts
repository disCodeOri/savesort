import "server-only";

import {
  createOAuthState,
  createPkceVerifier,
  decryptWithKey,
  encryptWithKey,
  readEncryptionKey,
} from "@/lib/crypto/secret-box";

const MISCONFIGURED = "X token encryption is not configured correctly.";
const DECRYPT_FAILED = "X credential could not be decrypted.";

/** Accepts the TWITTER_ alias, matching getXServerConfig. */
function encryptionKey() {
  try {
    return readEncryptionKey("X_TOKEN_ENCRYPTION_KEY", MISCONFIGURED);
  } catch {
    return readEncryptionKey("TWITTER_TOKEN_ENCRYPTION_KEY", MISCONFIGURED);
  }
}

/** X requires PKCE even for confidential clients, so both values are generated. */
export function createOAuthAttempt(): {
  state: string;
  verifier: string;
  challenge: string;
} {
  return { state: createOAuthState(), ...createPkceVerifier() };
}

export function encryptSecret(value: string): string {
  return encryptWithKey(value, encryptionKey());
}

export function decryptSecret(value: string): string {
  return decryptWithKey(value, encryptionKey(), DECRYPT_FAILED);
}
