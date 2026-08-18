import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { refreshOAuthToken, YouTubeApiError } from "@/lib/youtube/api";
import { decryptSecret, encryptSecret } from "@/lib/youtube/crypto";
import type { YouTubeChannel, YouTubeOAuthToken } from "@/lib/youtube/types";

const REFRESH_WINDOW_MS = 60_000;
const PUBLIC_CONNECTION_COLUMNS =
  "channel_id, channel_title, channel_thumbnail_url, connection_status, sync_status, last_synced_at, discovered_count, saved_count, skipped_count, last_sync_error";

export const YOUTUBE_RECONNECT_MESSAGE = "YouTube needs to be reconnected.";

type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  channel_id: string | null;
  channel_title: string | null;
  channel_thumbnail_url: string | null;
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

export interface YouTubeConnectionStatus {
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  channelThumbnailUrl: string | null;
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
  return new Error("YouTube connection could not be saved.");
}

function loadError(): Error {
  return new Error("YouTube connection could not be loaded.");
}

function reconnectError(): Error {
  return new Error(YOUTUBE_RECONNECT_MESSAGE);
}

function needsRefresh(value: string | null, now: number): boolean {
  return value === null || Date.parse(value) <= now + REFRESH_WINDOW_MS;
}

/**
 * Google issues a refresh token only on first consent. Without one the
 * connection dies in an hour, so the connect route asks for prompt=consent to
 * guarantee we get one.
 */
export function hasRefreshToken(token: YouTubeOAuthToken): boolean {
  return (
    typeof token.refresh_token === "string" && token.refresh_token.length > 0
  );
}

export async function saveYouTubeConnection(
  userId: string,
  channel: YouTubeChannel,
  token: YouTubeOAuthToken,
): Promise<void> {
  const now = new Date();
  const client = createAdminClient();

  try {
    const result = await client.rpc("save_youtube_connection", {
      p_user_id: userId,
      p_google_user_id: channel.googleUserId,
      p_channel_id: channel.channelId,
      p_channel_title: channel.title,
      p_channel_thumbnail_url: channel.thumbnailUrl,
      p_access_token_ciphertext: encryptSecret(token.access_token),
      p_refresh_token_ciphertext: token.refresh_token
        ? encryptSecret(token.refresh_token)
        : null,
      p_access_token_expires_at: expiresAt(token.expires_in, now),
    });
    if (result.error) throw saveError();
  } catch {
    throw saveError();
  }
}

export async function getYouTubeConnection(
  userId: string,
): Promise<YouTubeConnectionStatus | null> {
  const client = createAdminClient();
  let result: { data: ConnectionRow | null; error: unknown };

  try {
    result = await client
      .from("youtube_connections")
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
    channelId: result.data.channel_id,
    channelTitle: result.data.channel_title,
    channelThumbnailUrl: result.data.channel_thumbnail_url,
    connectionStatus: result.data.connection_status,
    syncStatus: result.data.sync_status,
    lastSyncedAt: result.data.last_synced_at,
    discoveredCount: result.data.discovered_count,
    savedCount: result.data.saved_count,
    skippedCount: result.data.skipped_count,
    lastSyncError: result.data.last_sync_error,
  };
}

export async function markYouTubeReconnectRequired(
  userId: string,
): Promise<void> {
  const client = createAdminClient();
  try {
    const result = await client
      .from("youtube_connections")
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
      .from("youtube_connection_secrets")
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
  token: YouTubeOAuthToken,
  secret: SecretRow,
): Promise<string> {
  const now = new Date();
  const client = createAdminClient();
  try {
    const result = await client
      .from("youtube_connection_secrets")
      .update({
        access_token_ciphertext: encryptSecret(token.access_token),
        // A Google refresh response omits the refresh token; the stored one
        // stays valid, so only replace it when a new one actually arrives.
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

  const winner = await loadSecret(userId);
  if (winner && !needsRefresh(winner.access_token_expires_at, Date.now())) {
    return decryptSecret(winner.access_token_ciphertext);
  }

  await markYouTubeReconnectRequired(userId);
  throw reconnectError();
}

export async function getValidYouTubeAccessToken(
  userId: string,
): Promise<string> {
  const secret = await loadSecret(userId);
  if (!secret) throw reconnectError();

  if (!needsRefresh(secret.access_token_expires_at, Date.now())) {
    return decryptSecret(secret.access_token_ciphertext);
  }

  if (!secret.refresh_token_ciphertext) {
    await markYouTubeReconnectRequired(userId);
    throw reconnectError();
  }

  try {
    const refreshed = await refreshOAuthToken(
      decryptSecret(secret.refresh_token_ciphertext),
    );
    return saveRefreshedToken(userId, refreshed, secret);
  } catch (error) {
    if (error instanceof YouTubeApiError && error.kind === "unauthorized") {
      await markYouTubeReconnectRequired(userId);
      throw reconnectError();
    }
    throw error;
  }
}

export async function disconnectYouTube(userId: string): Promise<void> {
  const client = createAdminClient();
  try {
    for (const table of [
      "youtube_connection_secrets",
      "youtube_playlists",
      "youtube_videos",
      "youtube_connections",
    ]) {
      const result = await client.from(table).delete().eq("user_id", userId);
      if (result.error) throw saveError();
    }
  } catch {
    throw saveError();
  }
}
