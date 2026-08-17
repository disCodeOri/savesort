import "server-only";

import {
  createOAuthState,
  decryptWithKey,
  encryptWithKey,
  readEncryptionKey,
} from "@/lib/crypto/secret-box";

const KEY_VARIABLE = "REDDIT_TOKEN_ENCRYPTION_KEY";
const MISCONFIGURED = "Reddit token encryption is not configured correctly.";
const DECRYPT_FAILED = "Reddit credential could not be decrypted.";

/**
 * Reddit's OAuth server does not implement PKCE, so an authorization attempt
 * only carries the CSRF state value.
 */
export function createOAuthAttempt(): { state: string } {
  return { state: createOAuthState() };
}

export function encryptSecret(value: string): string {
  return encryptWithKey(value, readEncryptionKey(KEY_VARIABLE, MISCONFIGURED));
}

export function decryptSecret(value: string): string {
  const key = readEncryptionKey(KEY_VARIABLE, MISCONFIGURED);
  return decryptWithKey(value, key, DECRYPT_FAILED);
}
