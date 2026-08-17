import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENCRYPTION_VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function toBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

/**
 * Reads a base64 AES-256-GCM key from the environment. Every provider keeps its
 * own key so one leaked secret cannot unlock another provider's tokens.
 */
export function readEncryptionKey(
  variableName: string,
  misconfiguredMessage: string,
): Buffer {
  const encodedKey = process.env[variableName];
  if (!encodedKey) throw new Error(misconfiguredMessage);

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== KEY_LENGTH) throw new Error(misconfiguredMessage);

  return key;
}

export function encryptWithKey(value: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(ciphertext),
  ].join(".");
}

export function decryptWithKey(
  value: string,
  key: Buffer,
  failureMessage: string,
): string {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
      value.split(".");
    if (
      version !== ENCRYPTION_VERSION ||
      !encodedIv ||
      !encodedTag ||
      !encodedCiphertext ||
      extra
    ) {
      throw new Error("Invalid encrypted credential.");
    }

    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new Error("Invalid encrypted credential.");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(failureMessage);
  }
}

export function createOAuthState(): string {
  return toBase64Url(randomBytes(32));
}

export function createPkceVerifier(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Compares two OAuth state values without leaking their length or contents. */
export function isExpectedOAuthState(
  receivedState: string,
  expectedState: string,
): boolean {
  const receivedDigest = createHash("sha256").update(receivedState).digest();
  const expectedDigest = createHash("sha256").update(expectedState).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}
