import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { refreshOAuthToken, revokeToken, XApiError } from "@/lib/x/api";
import { decryptSecret, encryptSecret } from "@/lib/x/crypto";
import type { XAccount, XOAuthToken } from "@/lib/x/types";

const REFRESH_WINDOW_MS = 60_000;
const PUBLIC_CONNECTION_COLUMNS =
  "x_user_id, username, display_name, profile_image_url, connection_status, sync_status, last_synced_at, discovered_count, saved_count, updated_count, skipped_count, last_sync_error, rate_limit_reset_at";

export const X_RECONNECT_MESSAGE = "X needs to be reconnected.";

type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed" | "rate_limited";

interface ConnectionRow {
  x_user_id: string;
  username: string;
  display_name: string | null;
  profile_image_url: string | null;
  connection_status: ConnectionStatus;
  sync_status: SyncStatus;
  last_synced_at: string | null;
  discovered_count: number;
  saved_count: number;
  updated_count: number;
  skipped_count: number;
  last_sync_error: string | null;
  rate_limit_reset_at: string | null;
}

interface SecretRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
}

export interface XConnectionStatus {
  connected: boolean;
  username: string;
  displayName: string | null;
  profileImageUrl: string | null;
  connectionStatus: ConnectionStatus;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  updatedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
  rateLimitResetAt: string | null;
}

function expiresAt(seconds: number | undefined, now: Date): string | null {
  if (seconds === undefined) return null;
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function saveError(): Error {
  return new Error("X connection could not be saved.");
}

function loadError(): Error {
  return new Error("X connection could not be loaded.");
}

function reconnectError(): Error {
  return new Error(X_RECONNECT_MESSAGE);
}

function needsRefresh(value: string | null, now: number): boolean {
  return value === null || Date.parse(value) <= now + REFRESH_WINDOW_MS;
}

export function hasRefreshToken(token: XOAuthToken): boolean {
  return (
    typeof token.refresh_token === "string" && token.refresh_token.length > 0
  );
}

export async function saveXConnection(
  userId: string,
  account: XAccount,
  token: XOAuthToken,
): Promise<void> {
  const now = new Date();
  const client = createAdminClient();

  try {
    const result = await client.rpc("save_x_connection", {
      p_user_id: userId,
      p_x_user_id: account.id,
      p_username: account.username,
      p_display_name: account.name,
      p_profile_image_url: account.profileImageUrl,
      p_access_token_ciphertext: encryptSecret(token.access_token),
      p_refresh_token_ciphertext: token.refresh_token
        ? encryptSecret(token.refresh_token)
        : null,
      p_access_token_expires_at: expiresAt(token.expires_in, now),
      p_granted_scopes: token.scope,
    });
    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
}

export async function getXConnection(
  userId: string,
): Promise<XConnectionStatus | null> {
  const client = createAdminClient();
  let result: { data: ConnectionRow | null; error: unknown };

  try {
    result = await client
      .from("x_connections")
      .select(PUBLIC_CONNECTION_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
  } catch {
    throw loadError();
  }

  if (result.error) throw loadError();
  if (!result.data) return null;

  return {
    connected: result.data.connection_status === "connected",
    username: result.data.username,
    displayName: result.data.display_name,
    profileImageUrl: result.data.profile_image_url,
    connectionStatus: result.data.connection_status,
    syncStatus: result.data.sync_status,
    lastSyncedAt: result.data.last_synced_at,
    discoveredCount: result.data.discovered_count,
    savedCount: result.data.saved_count,
    updatedCount: result.data.updated_count,
    skippedCount: result.data.skipped_count,
    lastSyncError: result.data.last_sync_error,
    rateLimitResetAt: result.data.rate_limit_reset_at,
  };
}

/** The X user id the sync must page against; never accepted from the client. */
export async function getConnectedXUserId(
  userId: string,
): Promise<string | null> {
  const client = createAdminClient();
  const result = await client
    .from("x_connections")
    .select("x_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw loadError();
  return (result.data as { x_user_id: string } | null)?.x_user_id ?? null;
}

export async function markXReconnectRequired(userId: string): Promise<void> {
  const client = createAdminClient();
  try {
    const result = await client
      .from("x_connections")
      .update({ connection_status: "reconnect_required" })
      .eq("user_id", userId);
    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
}

async function loadSecret(userId: string): Promise<SecretRow | null> {
  const client = createAdminClient();
  let result: { data: SecretRow | null; error: unknown };

  try {
    result = await client
      .from("x_connection_secrets")
      .select(
        "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at",
      )
      .eq("user_id", userId)
      .maybeSingle();
  } catch {
    throw loadError();
  }

  if (result.error) throw loadError();
  return result.data;
}

/**
 * Persists a refreshed token pair. The update is conditional on the
 * ciphertext we started from, so two concurrent refreshes cannot clobber each
 * other — the loser adopts the winner's token instead of overwriting it.
 */
async function saveRefreshedToken(
  userId: string,
  token: XOAuthToken,
  secret: SecretRow,
): Promise<string> {
  const now = new Date();
  const client = createAdminClient();
  try {
    const result = await client
      .from("x_connection_secrets")
      .update({
        access_token_ciphertext: encryptSecret(token.access_token),
        // X rotates refresh tokens: a refresh response carries a new one and
        // the old one stops working. Keep the previous only if none arrived.
        refresh_token_ciphertext: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : secret.refresh_token_ciphertext,
        access_token_expires_at: expiresAt(token.expires_in, now),
        granted_scopes: token.scope,
      })
      .eq("user_id", userId)
      .eq("access_token_ciphertext", secret.access_token_ciphertext)
      .select("access_token_ciphertext")
      .maybeSingle();

    if (result.error) throw saveError();
    if (result.data) return token.access_token;
  } catch {
    throw saveError();
  }

  const winner = await loadSecret(userId);
  if (winner && !needsRefresh(winner.access_token_expires_at, Date.now())) {
    return decryptSecret(winner.access_token_ciphertext);
  }

  await markXReconnectRequired(userId);
  throw reconnectError();
}

export async function getValidXAccessToken(userId: string): Promise<string> {
  const secret = await loadSecret(userId);
  if (!secret) throw reconnectError();

  if (!needsRefresh(secret.access_token_expires_at, Date.now())) {
    return decryptSecret(secret.access_token_ciphertext);
  }

  if (!secret.refresh_token_ciphertext) {
    await markXReconnectRequired(userId);
    throw reconnectError();
  }

  try {
    const refreshed = await refreshOAuthToken(
      decryptSecret(secret.refresh_token_ciphertext),
    );
    return saveRefreshedToken(userId, refreshed, secret);
  } catch (error) {
    // A rejected refresh token means the user revoked access on X's side.
    if (error instanceof XApiError && error.kind === "unauthorized") {
      await markXReconnectRequired(userId);
      throw reconnectError();
    }
    throw error;
  }
}

/**
 * Removes the connection and its credentials. Imported saved_items and the
 * user's notes and tags are intentionally left alone — disconnecting a
 * provider must never destroy the personal library built from it.
 */
export async function disconnectX(userId: string): Promise<void> {
  const client = createAdminClient();

  // Best effort revocation before the secret is destroyed. A failure here is
  // not fatal: local credentials still get removed, so GRAPPlin stops syncing
  // either way.
  try {
    const secret = await loadSecret(userId);
    if (secret)
      await revokeToken(decryptSecret(secret.access_token_ciphertext));
  } catch {
    // Intentionally ignored.
  }

  try {
    for (const table of ["x_connection_secrets", "x_connections"]) {
      const result = await client.from(table).delete().eq("user_id", userId);
      if (result.error) throw saveError();
    }
    // Bookmark rows keep pointing at saved_items so a later reconnect can
    // recognise what was already imported instead of duplicating it.
    const bookmarks = await client
      .from("x_bookmarks")
      .update({ active: false, last_seen_sync_id: null })
      .eq("user_id", userId);
    if (bookmarks.error) throw saveError();
  } catch {
    throw saveError();
  }
}
