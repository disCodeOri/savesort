import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createOAuthAttempt,
  decryptSecret,
  encryptSecret,
} from "@/lib/github/crypto";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe("GitHub secret protection", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = encryptionKey;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  });

  it("round-trips a token without storing plaintext", () => {
    const encrypted = encryptSecret("ghu_test_token");
    expect(encrypted).not.toContain("ghu_test_token");
    expect(decryptSecret(encrypted)).toBe("ghu_test_token");
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("ghu_test_token");
    expect(() => decryptSecret(`${encrypted}x`)).toThrow(
      "GitHub credential could not be decrypted.",
    );
  });

  it("rejects a ciphertext with a truncated authentication tag", () => {
    const [version, iv, tag, ciphertext] =
      encryptSecret("ghu_test_token").split(".");
    const truncatedTag = Buffer.from(tag, "base64url")
      .subarray(0, 15)
      .toString("base64url");

    expect(() =>
      decryptSecret([version, iv, truncatedTag, ciphertext].join(".")),
    ).toThrow("GitHub credential could not be decrypted.");
  });

  it("reports an invalid encryption key configuration during decryption", () => {
    const encrypted = encryptSecret("ghu_test_token");
    delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;

    expect(() => decryptSecret(encrypted)).toThrow(
      "GitHub token encryption is not configured correctly.",
    );
  });

  it("creates URL-safe state, verifier, and matching S256 challenge", () => {
    const attempt = createOAuthAttempt();
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(attempt.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
