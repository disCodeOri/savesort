import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createOpaqueToken,
  hashToken,
  isLoopbackRedirectUri,
  isMatchingPkceChallenge,
} from "@/lib/desktop/tokens";

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("device tokens", () => {
  it("issues unguessable tokens and stores only their digest", () => {
    const token = createOpaqueToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createOpaqueToken()).not.toBe(token);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
  });
});

describe("isMatchingPkceChallenge", () => {
  it("accepts the verifier that produced the challenge", () => {
    const verifier = randomBytes(32).toString("base64url");

    expect(isMatchingPkceChallenge(verifier, challengeFor(verifier))).toBe(
      true,
    );
  });

  it("rejects any other verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    const other = randomBytes(32).toString("base64url");

    expect(isMatchingPkceChallenge(other, challengeFor(verifier))).toBe(false);
    expect(isMatchingPkceChallenge("", challengeFor(verifier))).toBe(false);
  });
});

describe("isLoopbackRedirectUri", () => {
  it("accepts a loopback callback on an unprivileged port", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:52111/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:52111/callback")).toBe(true);
  });

  it("refuses to send an authorization code anywhere but this machine", () => {
    expect(isLoopbackRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isLoopbackRedirectUri("https://127.0.0.1:52111/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://localhost:52111/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://127.0.0.1:80/callback")).toBe(false);
    expect(isLoopbackRedirectUri("http://user:pw@127.0.0.1:52111/cb")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("not a url")).toBe(false);
  });
});
