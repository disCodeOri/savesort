import "server-only";

import { randomUUID } from "node:crypto";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import { embedDocument } from "@/lib/embeddings/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  listPlaylistItemsPage,
  listVideos,
  YouTubeApiError,
} from "@/lib/youtube/api";
import {
  getValidYouTubeAccessToken,
  YOUTUBE_RECONNECT_MESSAGE,
} from "@/lib/youtube/connections";
import {
  mapYouTubeVideo,
  type YouTubeProviderItem,
} from "@/lib/youtube/map-video";
import { selectedPlaylistIds } from "@/lib/youtube/playlists";

const CONNECTION_COLUMNS =
  "user_id, connection_status, sync_status, active_sync_id, next_page, sync_playlist_queue, next_page_token, discovered_count, saved_count, skipped_count, sync_started_at, last_synced_at, last_sync_error, page_lease_id, page_lease_started_at";
const EMBEDDING_CONCURRENCY = 4;
const PAGE_HEARTBEAT_INTERVAL_MS = 60_000;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";
const RECONNECT_ERROR = "YouTube access expired. Reconnect to resume syncing.";
const UNKNOWN_SYNC_ERROR = "YouTube sync failed. Try again later.";

type AdminClient = ReturnType<typeof createAdminClient>;
type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  user_id: string;
  connection_status: ConnectionStatus;
  sync_status: SyncStatus;
  active_sync_id: string | null;
  next_page: number;
  sync_playlist_queue: string[];
  next_page_token: string | null;
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
  sync_started_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  page_lease_id: string | null;
  page_lease_started_at: string | null;
}

interface SyncCounts {
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
}

export type YouTubeSyncProgress =
  | ({ status: "running"; syncId: string; nextPage: number } & SyncCounts)
  | ({
      status:
        | "complete"
        | "not_connected"
        | "reconnect_required"
        | "no_playlists"
        | "failed";
    } & SyncCounts);

export type YouTubeSyncErrorKind = "conflict" | "rate_limited" | "unavailable";

export class YouTubeSyncError extends Error {
  constructor(public readonly kind: YouTubeSyncErrorKind) {
    super(messageForSyncError(kind));
    this.name = "YouTubeSyncError";
  }
}

function messageForSyncError(kind: YouTubeSyncErrorKind): string {
  if (kind === "conflict") {
    return "This YouTube sync is no longer active. Start a new sync.";
  }
  if (kind === "rate_limited") {
    return "The YouTube API quota is exhausted. Try again later.";
  }
  return "YouTube sync is temporarily unavailable. Try again later.";
}

function counts(connection: ConnectionRow | null): SyncCounts {
  return {
    discoveredCount: connection?.discovered_count ?? 0,
    savedCount: connection?.saved_count ?? 0,
    skippedCount: connection?.skipped_count ?? 0,
  };
}

function terminalProgress(
  status: Exclude<YouTubeSyncProgress["status"], "running">,
  connection: ConnectionRow | null,
): YouTubeSyncProgress {
  return { status, ...counts(connection) };
}

function progressForConnection(
  connection: ConnectionRow | null,
): YouTubeSyncProgress {
  if (!connection) return terminalProgress("not_connected", null);
  if (connection.connection_status === "reconnect_required") {
    return terminalProgress("reconnect_required", connection);
  }
  if (
    connection.sync_status === "running" &&
    connection.active_sync_id !== null
  ) {
    return {
      status: "running",
      syncId: connection.active_sync_id,
      nextPage: connection.next_page,
      ...counts(connection),
    };
  }
  if (connection.sync_status === "failed") {
    return terminalProgress("failed", connection);
  }
  return terminalProgress("complete", connection);
}

async function loadConnection(
  client: AdminClient,
  userId: string,
): Promise<ConnectionRow | null> {
  const result = await client
    .from("youtube_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data as ConnectionRow | null;
}

async function cleanUpFailure(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string | null,
  error: string,
  reconnectRequired = false,
): Promise<boolean> {
  try {
    const result = await client.rpc("fail_youtube_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_page: page,
      p_lease_id: leaseId,
      p_error: error,
      p_reconnect_required: reconnectRequired,
    });
    if (result.error) return false;
    return result.data === true;
  } catch {
    return false;
  }
}

function startPageHeartbeat(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let failure: unknown = null;

  const schedule = () => {
    if (stopped || failure) return;
    timer = setTimeout(() => {
      timer = null;
      running = (async () => {
        try {
          const result = await client.rpc("heartbeat_youtube_sync_page", {
            p_user_id: userId,
            p_sync_id: syncId,
            p_page: page,
            p_lease_id: leaseId,
          });
          if (result.error || result.data !== true) {
            failure = new YouTubeSyncError("conflict");
          }
        } catch (error: unknown) {
          failure = error;
        } finally {
          running = null;
          schedule();
        }
      })();
    }, PAGE_HEARTBEAT_INTERVAL_MS);
  };

  schedule();
  return {
    async stop(): Promise<unknown> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running;
      return failure;
    },
  };
}

async function handlePageError(
  client: AdminClient,
  connection: ConnectionRow,
  syncId: string,
  page: number,
  leaseId: string,
  error: unknown,
): Promise<YouTubeSyncProgress> {
  if (
    (error instanceof YouTubeApiError && error.kind === "unauthorized") ||
    (error instanceof Error && error.message === YOUTUBE_RECONNECT_MESSAGE)
  ) {
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      page,
      leaseId,
      RECONNECT_ERROR,
      true,
    );
    if (!cleaned) throw new YouTubeSyncError("conflict");
    return terminalProgress("reconnect_required", connection);
  }
  if (error instanceof YouTubeApiError && error.kind === "rate_limited") {
    const syncError = new YouTubeSyncError("rate_limited");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      page,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new YouTubeSyncError("conflict");
    throw syncError;
  }
  if (error instanceof YouTubeApiError) {
    const syncError = new YouTubeSyncError("unavailable");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      page,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new YouTubeSyncError("conflict");
    throw syncError;
  }
  await cleanUpFailure(
    client,
    connection.user_id,
    syncId,
    page,
    leaseId,
    UNKNOWN_SYNC_ERROR,
  );
  throw error;
}

async function prepareRow(
  userId: string,
  item: YouTubeProviderItem,
): Promise<Record<string, unknown>> {
  try {
    const embedded = await embedDocument(item.searchable_text);
    return {
      ...item,
      user_id: userId,
      embedding: embedded.embedding
        ? `[${embedded.embedding.join(",")}]`
        : null,
      indexing_status: embedded.embedding ? "ready" : "keyword_only",
      indexing_error: embedded.embedding ? null : INDEXING_ERROR,
    };
  } catch {
    return {
      ...item,
      user_id: userId,
      embedding: null,
      indexing_status: "keyword_only",
      indexing_error: INDEXING_ERROR,
    };
  }
}

/**
 * Processes one page: a single playlistItems page of the playlist at the head
 * of the queue, plus the batched videos.list lookup for its ids. When the
 * playlist runs out of pages the queue head is dropped and the next sync page
 * starts the following playlist.
 */
async function processPage(
  client: AdminClient,
  userId: string,
  syncId: string,
): Promise<YouTubeSyncProgress> {
  const connection = await loadConnection(client, userId);
  if (!connection) return terminalProgress("not_connected", null);
  if (connection.connection_status === "reconnect_required") {
    return terminalProgress("reconnect_required", connection);
  }
  if (
    connection.sync_status !== "running" ||
    connection.active_sync_id !== syncId
  ) {
    throw new YouTubeSyncError("conflict");
  }

  const page = connection.next_page;
  const queue = connection.sync_playlist_queue ?? [];
  const playlistId = queue[0];
  if (!playlistId) return terminalProgress("complete", connection);

  const leaseId = randomUUID();
  const claimed = await client.rpc("claim_youtube_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
  });
  if (claimed.error || claimed.data !== true) {
    throw new YouTubeSyncError("conflict");
  }

  const heartbeat = startPageHeartbeat(client, userId, syncId, page, leaseId);
  try {
    const accessToken = await getValidYouTubeAccessToken(userId);
    const itemsPage = await listPlaylistItemsPage(
      accessToken,
      playlistId,
      connection.next_page_token,
    );
    const videos = await listVideos(accessToken, itemsPage.videoIds);

    const mapped: YouTubeProviderItem[] = [];
    const seen = new Set<string>();
    for (const video of videos) {
      try {
        const item = mapYouTubeVideo(video, playlistId);
        if (seen.has(item.normalized_url)) continue;
        seen.add(item.normalized_url);
        mapped.push(item);
      } catch {
        // A video whose id cannot form a valid URL is not indexable.
      }
    }

    const rows = await mapWithConcurrency(
      mapped,
      EMBEDDING_CONCURRENCY,
      (item) => prepareRow(userId, item),
    );

    const heartbeatError = await heartbeat.stop();
    if (heartbeatError) throw heartbeatError;

    // Advance within the playlist, or drop it and move to the next one.
    const morePages = itemsPage.nextPageToken !== null;
    const nextQueue = morePages ? queue : queue.slice(1);
    const nextToken = morePages ? itemsPage.nextPageToken : null;
    const complete = nextQueue.length === 0;

    // discovered counts everything the playlist page returned; skipped covers
    // both unusable playlist entries and videos the API withheld.
    const discovered = itemsPage.videoIds.length + itemsPage.skippedCount;
    const skipped = discovered - rows.length;

    const applied = await client.rpc("apply_youtube_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_lease_id: leaseId,
      p_page: page,
      p_next_page: complete ? null : page + 1,
      p_next_playlist_queue: nextQueue,
      p_next_page_token: nextToken,
      p_discovered_count: discovered,
      p_skipped_count: skipped,
      p_items: rows,
    });
    if (applied.error) throw applied.error;
    if (!applied.data) throw new YouTubeSyncError("conflict");

    const result = applied.data as {
      status: "running" | "complete";
      next_page: number | null;
      discovered_count: number;
      saved_count: number;
      skipped_count: number;
    };
    const resultCounts: SyncCounts = {
      discoveredCount: result.discovered_count,
      savedCount: result.saved_count,
      skippedCount: result.skipped_count,
    };
    if (result.status === "running" && result.next_page !== null) {
      return {
        status: "running",
        syncId,
        nextPage: result.next_page,
        ...resultCounts,
      };
    }
    return { status: "complete", ...resultCounts };
  } catch (error) {
    const heartbeatError = await heartbeat.stop();
    return handlePageError(
      client,
      connection,
      syncId,
      page,
      leaseId,
      heartbeatError ?? error,
    );
  }
}

export async function startYouTubeSync(
  userId: string,
): Promise<YouTubeSyncProgress> {
  const client = createAdminClient();
  const playlistIds = await selectedPlaylistIds(userId);
  if (playlistIds.length === 0) {
    return terminalProgress(
      "no_playlists",
      await loadConnection(client, userId),
    );
  }

  const syncId = randomUUID();
  const result = await client.rpc("begin_youtube_sync", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_playlist_queue: playlistIds,
  });
  if (result.error) {
    await cleanUpFailure(client, userId, syncId, 1, null, UNKNOWN_SYNC_ERROR);
    throw result.error;
  }
  if (!result.data) {
    return progressForConnection(await loadConnection(client, userId));
  }
  return processPage(client, userId, syncId);
}

export async function continueYouTubeSync(
  userId: string,
  syncId: string,
): Promise<YouTubeSyncProgress> {
  return processPage(createAdminClient(), userId, syncId);
}
