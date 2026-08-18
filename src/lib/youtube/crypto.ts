import "server-only";

import {
  createOAuthState,
  decryptWithKey,
  encryptWithKey,
  readEncryptionKey,
} from "@/lib/crypto/secret-box";

const KEY_VARIABLE = "YOUTUBE_TOKEN_ENCRYPTION_KEY";
const MISCONFIGURED = "YouTube token encryption is not configured correctly.";
const DECRYPT_FAILED = "YouTube credential could not be decrypted.";

/** Google's web flow uses state for CSRF; PKCE is not required for a confidential client. */
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
