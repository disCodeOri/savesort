import "server-only";

import { RedditApiError, refreshOAuthToken } from "@/lib/reddit/api";
import { decryptSecret, encryptSecret } from "@/lib/reddit/crypto";
import type { RedditIdentity, RedditOAuthToken } from "@/lib/reddit/types";
import { createAdminClient } from "@/lib/supabase/admin";

const REFRESH_WINDOW_MS = 60_000;
const PUBLIC_CONNECTION_COLUMNS =
  "reddit_username, reddit_icon_url, connection_status, sync_status, last_synced_at, discovered_count, saved_count, skipped_count, last_sync_error";

type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  reddit_username: string;
  reddit_icon_url: string | null;
  connection_status: ConnectionStatus;
  sync_status: SyncStatus;
  last_synced_at: string | null;
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
  last_sync_error: string | null;
}

interface SecretRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
}

export interface RedditConnectionStatus {
  connected: boolean;
  redditUsername: string;
  redditIconUrl: string | null;
  connectionStatus: ConnectionStatus;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
  lastSyncError: string | null;
}

function expiresAt(seconds: number | undefined, now: Date): string | null {
  if (seconds === undefined) return null;
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function saveError(): Error {
  return new Error("Reddit connection could not be saved.");
}

function loadError(): Error {
  return new Error("Reddit connection could not be loaded.");
}

function reconnectError(): Error {
  return new Error("Reddit needs to be reconnected.");
}

export const REDDIT_RECONNECT_MESSAGE = "Reddit needs to be reconnected.";

function needsRefresh(value: string | null, now: number): boolean {
  return value === null || Date.parse(value) <= now + REFRESH_WINDOW_MS;
}

/**
 * Reddit only issues a refresh token when the authorization used
 * `duration=permanent`; a temporary grant cannot be renewed later.
 */
export function isPermanentGrant(token: RedditOAuthToken): boolean {
  return (
    typeof token.refresh_token === "string" && token.refresh_token.length > 0
  );
}

export async function saveRedditConnection(
  userId: string,
  identity: RedditIdentity,
  token: RedditOAuthToken,
): Promise<void> {
  const now = new Date();
  const accessTokenCiphertext = encryptSecret(token.access_token);
  const refreshTokenCiphertext = token.refresh_token
    ? encryptSecret(token.refresh_token)
    : null;
  const client = createAdminClient();

  try {
    const result = await client.rpc("save_reddit_connection", {
      p_user_id: userId,
      p_reddit_user_id: identity.id,
      p_reddit_username: identity.name,
      p_reddit_icon_url: identity.icon_img,
      p_access_token_ciphertext: accessTokenCiphertext,
      p_refresh_token_ciphertext: refreshTokenCiphertext,
      p_access_token_expires_at: expiresAt(token.expires_in, now),
    });
    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
}

export async function getRedditConnection(
  userId: string,
): Promise<RedditConnectionStatus | null> {
  const client = createAdminClient();
  let result: { data: ConnectionRow | null; error: unknown };

  try {
    result = await client
      .from("reddit_connections")
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
    redditUsername: result.data.reddit_username,
    redditIconUrl: result.data.reddit_icon_url,
    connectionStatus: result.data.connection_status,
    syncStatus: result.data.sync_status,
    lastSyncedAt: result.data.last_synced_at,
    discoveredCount: result.data.discovered_count,
    savedCount: result.data.saved_count,
    skippedCount: result.data.skipped_count,
    lastSyncError: result.data.last_sync_error,
  };
}

export async function markRedditReconnectRequired(
  userId: string,
): Promise<void> {
  const client = createAdminClient();

  try {
    const result = await client
      .from("reddit_connections")
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
      .from("reddit_connection_secrets")
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

async function saveRefreshedToken(
  userId: string,
  token: RedditOAuthToken,
  secret: SecretRow,
): Promise<string> {
  const now = new Date();
  const client = createAdminClient();
  try {
    const result = await client
      .from("reddit_connection_secrets")
      .update({
        access_token_ciphertext: encryptSecret(token.access_token),
        // A refresh response usually omits the refresh token, and the existing
        // permanent one stays valid, so only replace it when Reddit sends one.
        refresh_token_ciphertext: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : secret.refresh_token_ciphertext,
        access_token_expires_at: expiresAt(token.expires_in, now),
      })
      .eq("user_id", userId)
      .eq("access_token_ciphertext", secret.access_token_ciphertext)
      .select("access_token_ciphertext, access_token_expires_at")
      .maybeSingle();

    if (result.error) throw saveError();
    if (result.data) return token.access_token;
  } catch {
    throw saveError();
  }

  // Another request refreshed first. Use its token when it is still fresh.
  const winner = await loadSecret(userId);
  if (winner && !needsRefresh(winner.access_token_expires_at, Date.now())) {
    return decryptSecret(winner.access_token_ciphertext);
  }

  await markRedditReconnectRequired(userId);
  throw reconnectError();
}

export async function getValidRedditAccessToken(
  userId: string,
): Promise<string> {
  const secret = await loadSecret(userId);
  if (!secret) throw reconnectError();

  if (!needsRefresh(secret.access_token_expires_at, Date.now())) {
    return decryptSecret(secret.access_token_ciphertext);
  }

  if (!secret.refresh_token_ciphertext) {
    await markRedditReconnectRequired(userId);
    throw reconnectError();
  }

  try {
    const refreshedToken = await refreshOAuthToken(
      decryptSecret(secret.refresh_token_ciphertext),
    );
    return saveRefreshedToken(userId, refreshedToken, secret);
  } catch (error) {
    if (error instanceof RedditApiError && error.kind === "unauthorized") {
      await markRedditReconnectRequired(userId);
      throw reconnectError();
    }
    throw error;
  }
}

export async function disconnectReddit(userId: string): Promise<void> {
  const client = createAdminClient();

  try {
    const secret = await client
      .from("reddit_connection_secrets")
      .delete()
      .eq("user_id", userId);
    if (secret.error) throw saveError();

    const connection = await client
      .from("reddit_connections")
      .delete()
      .eq("user_id", userId);
    if (connection.error) throw saveError();
  } catch {
    throw saveError();
  }
}
