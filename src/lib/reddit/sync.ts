import "server-only";

import { randomUUID } from "node:crypto";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import { embedDocument } from "@/lib/embeddings/gemini";
import { listSavedPostsPage, RedditApiError } from "@/lib/reddit/api";
import {
  getValidRedditAccessToken,
  REDDIT_RECONNECT_MESSAGE,
} from "@/lib/reddit/connections";
import {
  mapRedditSave,
  mergeRedditProviderItem,
  type RedditMergedItem,
  type RedditProviderItem,
} from "@/lib/reddit/map-save";
import type { RedditSavedPost } from "@/lib/reddit/types";
import { createAdminClient } from "@/lib/supabase/admin";

const CONNECTION_COLUMNS =
  "user_id, reddit_username, connection_status, sync_status, active_sync_id, next_page, next_cursor, discovered_count, saved_count, skipped_count, sync_started_at, last_synced_at, last_sync_error, page_lease_id, page_lease_started_at";
const SAVED_ITEM_COLUMNS =
  "user_id, url, normalized_url, source, title, description, notes, content, author, thumbnail_url, tags, metadata, searchable_text, embedding, indexing_status, indexing_error, updated_at";
const EMBEDDING_CONCURRENCY = 4;
const EXISTING_ITEM_CHUNK_SIZE = 25;
const PAGE_HEARTBEAT_INTERVAL_MS = 60_000;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";
const RECONNECT_ERROR = "Reddit access expired. Reconnect to resume syncing.";
const UNKNOWN_SYNC_ERROR = "Reddit sync failed. Try again later.";

type AdminClient = ReturnType<typeof createAdminClient>;
type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  user_id: string;
  reddit_username: string;
  connection_status: ConnectionStatus;
  sync_status: SyncStatus;
  active_sync_id: string | null;
  next_page: number;
  next_cursor: string | null;
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
  sync_started_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  page_lease_id: string | null;
  page_lease_started_at: string | null;
}

interface ExistingSavedItem {
  user_id: string;
  url: string;
  normalized_url: string;
  source: string;
  title: string | null;
  description: string | null;
  notes: string | null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  searchable_text: string;
  embedding: unknown;
  indexing_status: "ready" | "keyword_only" | "pending" | "failed";
  indexing_error: string | null;
  updated_at: string;
}

interface AppliedPage {
  status: "running" | "complete";
  next_page: number | null;
  next_cursor: string | null;
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
}

interface SyncCounts {
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
}

export type RedditSyncProgress =
  | ({
      status: "running";
      syncId: string;
      nextPage: number;
    } & SyncCounts)
  | ({
      status: "complete" | "not_connected" | "reconnect_required" | "failed";
    } & SyncCounts);

export type RedditSyncErrorKind = "conflict" | "rate_limited" | "unavailable";

export class RedditSyncError extends Error {
  constructor(public readonly kind: RedditSyncErrorKind) {
    super(messageForSyncError(kind));
    this.name = "RedditSyncError";
  }
}

function messageForSyncError(kind: RedditSyncErrorKind): string {
  if (kind === "conflict") {
    return "This Reddit sync is no longer active. Start a new sync.";
  }
  if (kind === "rate_limited") {
    return "Reddit is rate limited. Try again later.";
  }
  return "Reddit sync is temporarily unavailable. Try again later.";
}

function counts(connection: ConnectionRow | null): SyncCounts {
  return {
    discoveredCount: connection?.discovered_count ?? 0,
    savedCount: connection?.saved_count ?? 0,
    skippedCount: connection?.skipped_count ?? 0,
  };
}

function terminalProgress(
  status: "complete" | "not_connected" | "reconnect_required" | "failed",
  connection: ConnectionRow | null,
): RedditSyncProgress {
  return { status, ...counts(connection) };
}

function progressForConnection(
  connection: ConnectionRow | null,
): RedditSyncProgress {
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
    .from("reddit_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data as ConnectionRow | null;
}

async function claimPageLease(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string,
): Promise<void> {
  const result = await client.rpc("claim_reddit_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
  });
  if (result.error) throw result.error;
  if (result.data !== true) throw new RedditSyncError("conflict");
}

async function failPageLease(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string | null,
  error: string,
  reconnectRequired: boolean,
): Promise<boolean> {
  const result = await client.rpc("fail_reddit_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
    p_error: error,
    p_reconnect_required: reconnectRequired,
  });
  if (result.error) throw result.error;
  return result.data === true;
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
    return await failPageLease(
      client,
      userId,
      syncId,
      page,
      leaseId,
      error,
      reconnectRequired,
    );
  } catch {
    return false;
  }
}

async function heartbeatPageLease(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string,
): Promise<void> {
  const result = await client.rpc("heartbeat_reddit_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
  });
  if (result.error) throw result.error;
  if (result.data !== true) throw new RedditSyncError("conflict");
}

/**
 * Keeps the page lease alive while embeddings are generated, so a slow page is
 * not mistaken for a crashed one and taken over by another request.
 */
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
      running = heartbeatPageLease(client, userId, syncId, page, leaseId)
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          running = null;
          schedule();
        });
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
): Promise<RedditSyncProgress> {
  if (
    (error instanceof RedditApiError && error.kind === "unauthorized") ||
    (error instanceof Error && error.message === REDDIT_RECONNECT_MESSAGE)
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
    if (!cleaned) throw new RedditSyncError("conflict");
    return terminalProgress("reconnect_required", connection);
  }
  if (error instanceof RedditApiError && error.kind === "rate_limited") {
    const syncError = new RedditSyncError("rate_limited");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      page,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new RedditSyncError("conflict");
    throw syncError;
  }
  if (error instanceof RedditApiError && error.kind === "provider_error") {
    const syncError = new RedditSyncError("unavailable");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      page,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new RedditSyncError("conflict");
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

/**
 * Turns a page of saved posts into items, dropping anything unusable. Whatever
 * is dropped stays visible in the sync counts as a skipped item.
 */
function mapPosts(posts: RedditSavedPost[]): RedditProviderItem[] {
  const items: RedditProviderItem[] = [];
  const normalizedUrls = new Set<string>();

  for (const post of posts) {
    try {
      const item = mapRedditSave(post);
      if (normalizedUrls.has(item.normalized_url)) continue;
      normalizedUrls.add(item.normalized_url);
      items.push(item);
    } catch {
      // A post without a usable permalink cannot be saved or searched.
    }
  }

  return items;
}

async function loadExistingItems(
  client: AdminClient,
  userId: string,
  normalizedUrls: string[],
): Promise<ExistingSavedItem[]> {
  if (normalizedUrls.length === 0) return [];
  const items: ExistingSavedItem[] = [];
  for (
    let index = 0;
    index < normalizedUrls.length;
    index += EXISTING_ITEM_CHUNK_SIZE
  ) {
    const result = await client
      .from("saved_items")
      .select(SAVED_ITEM_COLUMNS)
      .eq("user_id", userId)
      .in(
        "normalized_url",
        normalizedUrls.slice(index, index + EXISTING_ITEM_CHUNK_SIZE),
      );
    if (result.error) throw result.error;
    items.push(...((result.data ?? []) as ExistingSavedItem[]));
  }
  return items;
}

function itemWithUserFields(
  provider: RedditProviderItem,
  existing: ExistingSavedItem | undefined,
): RedditProviderItem | RedditMergedItem {
  if (!existing) return provider;
  return mergeRedditProviderItem(existing, provider);
}

async function prepareSavedRow(
  userId: string,
  provider: RedditProviderItem,
  existing: ExistingSavedItem | undefined,
): Promise<Record<string, unknown>> {
  const item = itemWithUserFields(provider, existing);
  if (existing && existing.searchable_text === item.searchable_text) {
    return {
      ...item,
      user_id: userId,
      embedding: existing.embedding,
      indexing_status: existing.indexing_status,
      indexing_error: existing.indexing_error,
      expected_updated_at: existing.updated_at,
    };
  }

  try {
    const embedded = await embedDocument(item.searchable_text);
    return {
      ...item,
      user_id: userId,
      embedding: embedded.embedding,
      indexing_status: embedded.embedding ? "ready" : "keyword_only",
      indexing_error: embedded.embedding ? null : INDEXING_ERROR,
      expected_updated_at: existing?.updated_at ?? null,
    };
  } catch {
    return {
      ...item,
      user_id: userId,
      embedding: null,
      indexing_status: "keyword_only",
      indexing_error: INDEXING_ERROR,
      expected_updated_at: existing?.updated_at ?? null,
    };
  }
}

async function processPage(
  client: AdminClient,
  userId: string,
  syncId: string,
): Promise<RedditSyncProgress> {
  const connection = await loadConnection(client, userId);
  if (!connection) return terminalProgress("not_connected", null);
  if (connection.connection_status === "reconnect_required") {
    return terminalProgress("reconnect_required", connection);
  }
  if (
    connection.sync_status !== "running" ||
    connection.active_sync_id !== syncId
  ) {
    throw new RedditSyncError("conflict");
  }

  const page = connection.next_page;
  const cursor = connection.next_cursor;
  const leaseId = randomUUID();
  try {
    await claimPageLease(client, userId, syncId, page, leaseId);
  } catch (error) {
    if (error instanceof RedditSyncError && error.kind === "conflict") {
      throw error;
    }
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      page,
      leaseId,
      UNKNOWN_SYNC_ERROR,
    );
    if (!cleaned) {
      await cleanUpFailure(
        client,
        userId,
        syncId,
        page,
        null,
        UNKNOWN_SYNC_ERROR,
      );
    }
    throw error;
  }

  const heartbeat = startPageHeartbeat(client, userId, syncId, page, leaseId);
  try {
    const accessToken = await getValidRedditAccessToken(userId);
    const providerPage = await listSavedPostsPage(
      accessToken,
      connection.reddit_username,
      cursor,
    );
    const items = mapPosts(providerPage.posts);
    const existingItems = await loadExistingItems(
      client,
      userId,
      items.map((item) => item.normalized_url),
    );
    const existingByUrl = new Map(
      existingItems.map((item) => [item.normalized_url, item]),
    );
    const rows = await mapWithConcurrency(
      items,
      EMBEDDING_CONCURRENCY,
      (item) =>
        prepareSavedRow(userId, item, existingByUrl.get(item.normalized_url)),
    );
    const heartbeatError = await heartbeat.stop();
    if (heartbeatError) throw heartbeatError;

    const nextCursor = providerPage.nextCursor;
    // Children Reddit returned but SaveSort could not turn into an item,
    // such as saved comments or posts without a usable permalink.
    const unusableCount = providerPage.discoveredCount - items.length;
    const applied = await client.rpc("apply_reddit_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_lease_id: leaseId,
      p_page: page,
      p_next_page: nextCursor === null ? null : page + 1,
      p_next_cursor: nextCursor,
      p_discovered_count: providerPage.discoveredCount,
      p_skipped_count: unusableCount,
      p_items: rows,
    });
    if (applied.error) throw applied.error;
    if (!applied.data) throw new RedditSyncError("conflict");

    const result = applied.data as AppliedPage;
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
    if (result.status === "complete" && result.next_page === null) {
      return { status: "complete", ...resultCounts };
    }
    throw new Error("Reddit sync returned invalid progress.");
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

export async function startRedditSync(
  userId: string,
): Promise<RedditSyncProgress> {
  const client = createAdminClient();
  const syncId = randomUUID();
  const result = await client.rpc("begin_reddit_sync", {
    p_user_id: userId,
    p_sync_id: syncId,
  });
  if (result.error) {
    await cleanUpFailure(client, userId, syncId, 1, null, UNKNOWN_SYNC_ERROR);
    throw result.error;
  }
  if (!result.data)
    return progressForConnection(await loadConnection(client, userId));
  return processPage(client, userId, syncId);
}

export async function continueRedditSync(
  userId: string,
  syncId: string,
): Promise<RedditSyncProgress> {
  return processPage(createAdminClient(), userId, syncId);
}
