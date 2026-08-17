import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ACCESS_TOKEN_LIFETIME_MS,
  AUTH_CODE_LIFETIME_MS,
  createOpaqueToken,
  expiresAt,
  hashToken,
  isMatchingPkceChallenge,
  REFRESH_TOKEN_LIFETIME_MS,
} from "@/lib/desktop/tokens";

export interface DesktopSession {
  userId: string;
  deviceId: string;
}

export interface DesktopTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface AuthCodeRow {
  code_hash: string;
  user_id: string;
  code_challenge: string;
  redirect_uri: string;
  consumed_at: string | null;
  expires_at: string;
}

function authError(): Error {
  return new Error("DESKTOP_AUTH_FAILED");
}

/** Issues a single-use authorization code bound to the client's PKCE challenge. */
export async function createAuthorizationCode(
  userId: string,
  codeChallenge: string,
  redirectUri: string,
  deviceName: string,
): Promise<string> {
  const code = createOpaqueToken();
  const client = createAdminClient();
  const result = await client.from("desktop_auth_codes").insert({
    code_hash: hashToken(code),
    user_id: userId,
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
    device_name: deviceName,
    expires_at: expiresAt(AUTH_CODE_LIFETIME_MS),
  });
  if (result.error) {
    // The client only ever sees the opaque failure, but the operator needs the
    // real cause: a missing table or a rejected constraint is invisible
    // otherwise, and this call sits behind a browser redirect where there is
    // nowhere else to look.
    console.error("desktop authorization code insert failed", {
      code: result.error.code,
      message: result.error.message,
    });
    throw authError();
  }
  return code;
}

function tokenPair(): {
  pair: DesktopTokenPair;
  accessHash: string;
  refreshHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
} {
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  return {
    pair: {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_LIFETIME_MS / 1_000),
    },
    accessHash: hashToken(accessToken),
    refreshHash: hashToken(refreshToken),
    accessExpiresAt: expiresAt(ACCESS_TOKEN_LIFETIME_MS),
    refreshExpiresAt: expiresAt(REFRESH_TOKEN_LIFETIME_MS),
  };
}

/**
 * Trades an authorization code plus its PKCE verifier for the device's first
 * token pair. The code is read and validated before redemption so a mismatched
 * verifier cannot burn a code the legitimate client still needs.
 */
export async function redeemAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<DesktopTokenPair> {
  const client = createAdminClient();
  const codeHash = hashToken(code);
  const stored = await client
    .from("desktop_auth_codes")
    .select(
      "code_hash, user_id, code_challenge, redirect_uri, consumed_at, expires_at",
    )
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (stored.error) throw authError();

  const row = stored.data as AuthCodeRow | null;
  if (
    !row ||
    row.consumed_at !== null ||
    Date.parse(row.expires_at) <= Date.now() ||
    row.redirect_uri !== redirectUri ||
    !isMatchingPkceChallenge(verifier, row.code_challenge)
  ) {
    throw authError();
  }

  const tokens = tokenPair();
  const redeemed = await client.rpc("redeem_desktop_auth_code", {
    p_code_hash: codeHash,
    p_access_token_hash: tokens.accessHash,
    p_refresh_token_hash: tokens.refreshHash,
    p_access_expires_at: tokens.accessExpiresAt,
    p_refresh_expires_at: tokens.refreshExpiresAt,
  });
  if (redeemed.error || !redeemed.data) throw authError();
  return tokens.pair;
}

/** Rotates a refresh token, invalidating the presented one in the same statement. */
export async function rotateRefreshToken(
  refreshToken: string,
): Promise<DesktopTokenPair> {
  const client = createAdminClient();
  const tokens = tokenPair();
  const rotated = await client.rpc("rotate_desktop_device_token", {
    p_refresh_token_hash: hashToken(refreshToken),
    p_access_token_hash: tokens.accessHash,
    p_next_refresh_token_hash: tokens.refreshHash,
    p_access_expires_at: tokens.accessExpiresAt,
    p_refresh_expires_at: tokens.refreshExpiresAt,
  });
  if (rotated.error || !rotated.data) throw authError();
  return tokens.pair;
}

/** Resolves a bearer access token to its owner, or null when it is not usable. */
export async function resolveAccessToken(
  accessToken: string,
): Promise<DesktopSession | null> {
  const client = createAdminClient();
  const result = await client
    .from("desktop_device_tokens")
    .select(
      "device_id, access_expires_at, consumed_at, desktop_devices!inner(user_id, revoked_at)",
    )
    .eq("access_token_hash", hashToken(accessToken))
    .maybeSingle();
  if (result.error || !result.data) return null;

  const row = result.data as unknown as {
    device_id: string;
    access_expires_at: string;
    consumed_at: string | null;
    desktop_devices: { user_id: string; revoked_at: string | null };
  };
  if (
    row.consumed_at !== null ||
    Date.parse(row.access_expires_at) <= Date.now() ||
    row.desktop_devices.revoked_at !== null
  ) {
    return null;
  }

  return { userId: row.desktop_devices.user_id, deviceId: row.device_id };
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const client = createAdminClient();
  const result = await client
    .from("desktop_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", deviceId);
  if (result.error) throw authError();
}
