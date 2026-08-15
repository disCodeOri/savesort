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
    const connection = await client
      .from("github_connections")
      .upsert({
        user_id: userId,
        github_user_id: user.id,
        github_login: user.login,
        github_avatar_url: user.avatar_url,
        connection_status: "connected",
        sync_status: "idle",
      })
      .eq("user_id", userId);
    if (connection.error) throw saveError();

    const secret = await client
      .from("github_connection_secrets")
      .upsert({
        user_id: userId,
        access_token_ciphertext: accessTokenCiphertext,
        refresh_token_ciphertext: refreshTokenCiphertext,
        access_token_expires_at: expiresAt(token.expires_in, now),
        refresh_token_expires_at: expiresAt(
          token.refresh_token_expires_in,
          now,
        ),
      })
      .eq("user_id", userId);
    if (secret.error) throw saveError();
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
): Promise<void> {
  const now = new Date();
  const client = createAdminClient();
  try {
    const result = await client
      .from("github_connection_secrets")
      .update({
        access_token_ciphertext: encryptSecret(token.access_token),
        refresh_token_ciphertext: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : secret.refresh_token_ciphertext,
        access_token_expires_at: expiresAt(token.expires_in, now),
        refresh_token_expires_at:
          token.refresh_token_expires_in === undefined
            ? secret.refresh_token_expires_at
            : expiresAt(token.refresh_token_expires_in, now),
      })
      .eq("user_id", userId);

    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
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
    await saveRefreshedToken(userId, refreshedToken, secret);
    return refreshedToken.access_token;
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
