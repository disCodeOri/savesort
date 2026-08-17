import "server-only";

import {
  createOAuthState,
  createPkceVerifier,
  decryptWithKey,
  encryptWithKey,
  readEncryptionKey,
} from "@/lib/crypto/secret-box";

const KEY_VARIABLE = "GITHUB_TOKEN_ENCRYPTION_KEY";
const MISCONFIGURED = "GitHub token encryption is not configured correctly.";
const DECRYPT_FAILED = "GitHub credential could not be decrypted.";

export function createOAuthAttempt(): {
  state: string;
  verifier: string;
  challenge: string;
} {
  return { state: createOAuthState(), ...createPkceVerifier() };
}

export function encryptSecret(value: string): string {
  return encryptWithKey(value, readEncryptionKey(KEY_VARIABLE, MISCONFIGURED));
}

export function decryptSecret(value: string): string {
  const key = readEncryptionKey(KEY_VARIABLE, MISCONFIGURED);
  return decryptWithKey(value, key, DECRYPT_FAILED);
}
