import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Desktop credentials are opaque random strings, never JWTs. Only their SHA-256
 * digests reach the database, so a leaked table cannot be replayed against the
 * API, and a device can be revoked without touching the user's browser session.
 */
export const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
export const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1_000;
export const AUTH_CODE_LIFETIME_MS = 2 * 60 * 1_000;

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function expiresAt(lifetimeMs: number, now = Date.now()): string {
  return new Date(now + lifetimeMs).toISOString();
}

/** Verifies an RFC 7636 S256 PKCE challenge without leaking timing. */
export function isMatchingPkceChallenge(
  verifier: string,
  challenge: string,
): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const computedDigest = createHash("sha256").update(computed).digest();
  const expectedDigest = createHash("sha256").update(challenge).digest();
  return timingSafeEqual(computedDigest, expectedDigest);
}

/**
 * The desktop client listens on an ephemeral loopback port, so the redirect
 * target is only ever the user's own machine. Anything else would let a crafted
 * authorize link forward a code to an attacker.
 */
export function isLoopbackRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1_024 && port <= 65_535;
}

export function buildRedirect(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
