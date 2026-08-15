import "server-only";

import { GitHubApiError, refreshOAuthToken } from "@/lib/github/api";
import { decryptSecret, encryptSecret } from "@/lib/github/crypto";
import type {
  GitHubAuthenticatedUser,
  GitHubOAuthToken,
} from "@/lib/github/types";
import { createAdminClient } from "@/lib/supabase/admin";

const REFRESH_WINDOW_MS = 60_000;
const PUBLIC_CONNECTION_COLUMNS =
  "github_login, github_avatar_url, connection_status, sync_status, last_synced_at, discovered_count, saved_count, skipped_count, last_sync_error";

type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  github_login: string;
  github_avatar_url: string | null;
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
  refresh_token_expires_at: string | null;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  githubLogin: string;
  githubAvatarUrl: string | null;
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
  return new Error("GitHub connection could not be saved.");
}

function loadError(): Error {
  return new Error("GitHub connection could not be loaded.");
}

function reconnectError(): Error {
  return new Error("GitHub needs to be reconnected.");
}

function isExpired(value: string | null, now: number): boolean {
  return value !== null && Date.parse(value) <= now;
}

function needsRefresh(value: string | null, now: number): boolean {
  return value === null || Date.parse(value) <= now + REFRESH_WINDOW_MS;
}

function hasCompleteRotation(token: GitHubOAuthToken): boolean {
  return (
    typeof token.refresh_token === "string" &&
    token.refresh_token.length > 0 &&
    typeof token.refresh_token_expires_in === "number" &&
    Number.isFinite(token.refresh_token_expires_in) &&
    token.refresh_token_expires_in > 0
  );
}

export async function saveGitHubConnection(
  userId: string,
  user: GitHubAuthenticatedUser,
  token: GitHubOAuthToken,
): Promise<void> {
  const now = new Date();
  const accessTokenCiphertext = encryptSecret(token.access_token);
  const refreshTokenCiphertext = token.refresh_token
    ? encryptSecret(token.refresh_token)
    : null;
  const client = createAdminClient();

  try {
    const result = await client.rpc("save_github_connection", {
      p_user_id: userId,
      p_github_user_id: user.id,
      p_github_login: user.login,
      p_github_avatar_url: user.avatar_url,
      p_access_token_ciphertext: accessTokenCiphertext,
      p_refresh_token_ciphertext: refreshTokenCiphertext,
      p_access_token_expires_at: expiresAt(token.expires_in, now),
      p_refresh_token_expires_at: expiresAt(
        token.refresh_token_expires_in,
        now,
      ),
    });
    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
}

export async function getGitHubConnection(
  userId: string,
): Promise<GitHubConnectionStatus | null> {
  const client = createAdminClient();
  let result: { data: ConnectionRow | null; error: unknown };

  try {
    result = await client
      .from("github_connections")
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
    githubLogin: result.data.github_login,
    githubAvatarUrl: result.data.github_avatar_url,
    connectionStatus: result.data.connection_status,
    syncStatus: result.data.sync_status,
    lastSyncedAt: result.data.last_synced_at,
    discoveredCount: result.data.discovered_count,
    savedCount: result.data.saved_count,
    skippedCount: result.data.skipped_count,
    lastSyncError: result.data.last_sync_error,
  };
}

export async function markGitHubReconnectRequired(
  userId: string,
): Promise<void> {
  const client = createAdminClient();

  try {
    const result = await client
      .from("github_connections")
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
      .from("github_connection_secrets")
      .select(
        "access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, refresh_token_expires_at",
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
  token: GitHubOAuthToken,
  secret: SecretRow,
): Promise<string> {
  const now = new Date();
  const client = createAdminClient();
  try {
    const result = await client
      .from("github_connection_secrets")
      .update({
        access_token_ciphertext: encryptSecret(token.access_token),
        refresh_token_ciphertext: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : null,
        access_token_expires_at: expiresAt(token.expires_in, now),
        refresh_token_expires_at: expiresAt(
          token.refresh_token_expires_in,
          now,
        ),
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

  const winner = await loadSecret(userId);
  if (winner && !needsRefresh(winner.access_token_expires_at, Date.now())) {
    return decryptSecret(winner.access_token_ciphertext);
  }

  await markGitHubReconnectRequired(userId);
  throw reconnectError();
}

export async function getValidGitHubAccessToken(
  userId: string,
): Promise<string> {
  const secret = await loadSecret(userId);
  if (!secret) throw reconnectError();

  const now = Date.now();
  if (!needsRefresh(secret.access_token_expires_at, now)) {
    return decryptSecret(secret.access_token_ciphertext);
  }

  if (
    !secret.refresh_token_ciphertext ||
    isExpired(secret.refresh_token_expires_at, now)
  ) {
    await markGitHubReconnectRequired(userId);
    throw reconnectError();
  }

  try {
    const refreshedToken = await refreshOAuthToken(
      decryptSecret(secret.refresh_token_ciphertext),
    );
    if (!hasCompleteRotation(refreshedToken)) {
      await markGitHubReconnectRequired(userId);
      throw reconnectError();
    }
    return saveRefreshedToken(userId, refreshedToken, secret);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "unauthorized") {
      await markGitHubReconnectRequired(userId);
      throw reconnectError();
    }
    throw error;
  }
}

export async function disconnectGitHub(userId: string): Promise<void> {
  const client = createAdminClient();

  try {
    const secret = await client
      .from("github_connection_secrets")
      .delete()
      .eq("user_id", userId);
    if (secret.error) throw saveError();

    const connection = await client
      .from("github_connections")
      .delete()
      .eq("user_id", userId);
    if (connection.error) throw saveError();
  } catch {
    throw saveError();
  }
}
