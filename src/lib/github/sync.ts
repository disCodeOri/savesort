import "server-only";

import { randomUUID } from "node:crypto";

import { embedDocument } from "@/lib/embeddings/gemini";
import { GitHubApiError, listStarredRepositoriesPage } from "@/lib/github/api";
import { mapWithConcurrency } from "@/lib/github/concurrency";
import { getValidGitHubAccessToken } from "@/lib/github/connections";
import {
  mapGitHubStar,
  mergeGitHubProviderItem,
  type GitHubMergedItem,
  type GitHubProviderItem,
} from "@/lib/github/map-star";
import { createAdminClient } from "@/lib/supabase/admin";

const CONNECTION_COLUMNS =
  "user_id, connection_status, sync_status, active_sync_id, next_page, discovered_count, saved_count, skipped_count, sync_started_at, last_synced_at, last_sync_error";
const SAVED_ITEM_COLUMNS =
  "user_id, url, normalized_url, source, title, description, notes, content, author, thumbnail_url, tags, metadata, searchable_text, embedding, indexing_status, indexing_error";
const EMBEDDING_CONCURRENCY = 4;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";
const RECONNECT_ERROR = "GitHub access expired. Reconnect to resume syncing.";

type AdminClient = ReturnType<typeof createAdminClient>;
type ConnectionStatus = "connected" | "reconnect_required";
type SyncStatus = "idle" | "running" | "failed";

interface ConnectionRow {
  user_id: string;
  connection_status: ConnectionStatus;
  sync_status: SyncStatus;
  active_sync_id: string | null;
  next_page: number;
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
  sync_started_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
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
  embedding: number[] | null;
  indexing_status: "ready" | "keyword_only" | "pending" | "failed";
  indexing_error: string | null;
}

interface SyncCounts {
  discoveredCount: number;
  savedCount: number;
  skippedCount: number;
}

export type GitHubSyncProgress =
  | ({
      status: "running";
      syncId: string;
      nextPage: number;
    } & SyncCounts)
  | ({
      status: "complete" | "not_connected" | "reconnect_required" | "failed";
    } & SyncCounts);

export type GitHubSyncErrorKind = "conflict" | "rate_limited" | "unavailable";

export class GitHubSyncError extends Error {
  constructor(public readonly kind: GitHubSyncErrorKind) {
    super(messageForSyncError(kind));
    this.name = "GitHubSyncError";
  }
}

function messageForSyncError(kind: GitHubSyncErrorKind): string {
  if (kind === "conflict") {
    return "This GitHub sync is no longer active. Start a new sync.";
  }
  if (kind === "rate_limited") {
    return "GitHub is rate limited. Try again later.";
  }
  return "GitHub sync is temporarily unavailable. Try again later.";
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
): GitHubSyncProgress {
  return { status, ...counts(connection) };
}

function progressForConnection(
  connection: ConnectionRow | null,
): GitHubSyncProgress {
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
    .from("github_connections")
    .select(CONNECTION_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data as ConnectionRow | null;
}

async function guardedConnectionUpdate(
  client: AdminClient,
  userId: string,
  syncId: string,
  values: Record<string, unknown>,
): Promise<ConnectionRow> {
  const result = await client
    .from("github_connections")
    .update({ ...values, user_id: userId })
    .eq("user_id", userId)
    .eq("active_sync_id", syncId)
    .select(CONNECTION_COLUMNS)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new GitHubSyncError("conflict");
  return result.data as ConnectionRow;
}

async function reconnectRequired(
  client: AdminClient,
  connection: ConnectionRow,
  syncId: string,
): Promise<GitHubSyncProgress> {
  const updated = await guardedConnectionUpdate(
    client,
    connection.user_id,
    syncId,
    {
      connection_status: "reconnect_required",
      sync_status: "failed",
      active_sync_id: null,
      last_sync_error: RECONNECT_ERROR,
    },
  );
  return terminalProgress("reconnect_required", updated);
}

async function failProviderSync(
  client: AdminClient,
  connection: ConnectionRow,
  syncId: string,
  kind: "rate_limited" | "unavailable",
): Promise<never> {
  const error = new GitHubSyncError(kind);
  await guardedConnectionUpdate(client, connection.user_id, syncId, {
    sync_status: "failed",
    active_sync_id: null,
    last_sync_error: error.message,
  });
  throw error;
}

async function handleGitHubError(
  client: AdminClient,
  connection: ConnectionRow,
  syncId: string,
  error: unknown,
): Promise<GitHubSyncProgress> {
  if (
    (error instanceof GitHubApiError && error.kind === "unauthorized") ||
    (error instanceof Error &&
      error.message === "GitHub needs to be reconnected.")
  ) {
    return reconnectRequired(client, connection, syncId);
  }
  if (error instanceof GitHubApiError && error.kind === "rate_limited") {
    return failProviderSync(client, connection, syncId, "rate_limited");
  }
  if (error instanceof GitHubApiError && error.kind === "provider_error") {
    return failProviderSync(client, connection, syncId, "unavailable");
  }
  throw error;
}

function mapRepositories(repositories: Parameters<typeof mapGitHubStar>[0][]): {
  items: GitHubProviderItem[];
  skippedCount: number;
} {
  const items: GitHubProviderItem[] = [];
  const normalizedUrls = new Set<string>();
  let skippedCount = 0;

  for (const repository of repositories) {
    try {
      const item = mapGitHubStar(repository);
      if (normalizedUrls.has(item.normalized_url)) {
        skippedCount += 1;
        continue;
      }
      normalizedUrls.add(item.normalized_url);
      items.push(item);
    } catch {
      skippedCount += 1;
    }
  }

  return { items, skippedCount };
}

async function loadExistingItems(
  client: AdminClient,
  userId: string,
  normalizedUrls: string[],
): Promise<ExistingSavedItem[]> {
  if (normalizedUrls.length === 0) return [];
  const result = await client
    .from("saved_items")
    .select(SAVED_ITEM_COLUMNS)
    .eq("user_id", userId)
    .in("normalized_url", normalizedUrls);
  if (result.error) throw result.error;
  return (result.data ?? []) as ExistingSavedItem[];
}

function itemWithUserFields(
  provider: GitHubProviderItem,
  existing: ExistingSavedItem | undefined,
): GitHubProviderItem | GitHubMergedItem {
  if (!existing) return provider;
  return mergeGitHubProviderItem(existing, provider);
}

async function prepareSavedRow(
  userId: string,
  provider: GitHubProviderItem,
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

async function processPage(
  client: AdminClient,
  userId: string,
  syncId: string,
): Promise<GitHubSyncProgress> {
  const connection = await loadConnection(client, userId);
  if (!connection) return terminalProgress("not_connected", null);
  if (connection.connection_status === "reconnect_required") {
    return terminalProgress("reconnect_required", connection);
  }
  if (
    connection.sync_status !== "running" ||
    connection.active_sync_id !== syncId
  ) {
    throw new GitHubSyncError("conflict");
  }

  let accessToken: string;
  try {
    accessToken = await getValidGitHubAccessToken(userId);
  } catch (error) {
    return handleGitHubError(client, connection, syncId, error);
  }

  let page: Awaited<ReturnType<typeof listStarredRepositoriesPage>>;
  try {
    page = await listStarredRepositoriesPage(accessToken, connection.next_page);
  } catch (error) {
    return handleGitHubError(client, connection, syncId, error);
  }

  const mapped = mapRepositories(page.repositories);
  const existingItems = await loadExistingItems(
    client,
    userId,
    mapped.items.map((item) => item.normalized_url),
  );
  const existingByUrl = new Map(
    existingItems.map((item) => [item.normalized_url, item]),
  );
  const rows = await mapWithConcurrency(
    mapped.items,
    EMBEDDING_CONCURRENCY,
    (item) =>
      prepareSavedRow(userId, item, existingByUrl.get(item.normalized_url)),
  );

  if (rows.length > 0) {
    const saved = await client.from("saved_items").upsert(rows, {
      onConflict: "user_id,normalized_url",
    });
    if (saved.error) throw saved.error;
  }

  const nextCounts: SyncCounts = {
    discoveredCount: connection.discovered_count + page.repositories.length,
    savedCount:
      connection.saved_count +
      mapped.items.filter((item) => !existingByUrl.has(item.normalized_url))
        .length,
    skippedCount: connection.skipped_count + mapped.skippedCount,
  };
  const databaseCounts = {
    discovered_count: nextCounts.discoveredCount,
    saved_count: nextCounts.savedCount,
    skipped_count: nextCounts.skippedCount,
  };

  if (page.nextPage !== null) {
    await guardedConnectionUpdate(client, userId, syncId, {
      ...databaseCounts,
      next_page: page.nextPage,
      last_sync_error: null,
    });
    return {
      status: "running",
      syncId,
      nextPage: page.nextPage,
      ...nextCounts,
    };
  }

  await guardedConnectionUpdate(client, userId, syncId, {
    ...databaseCounts,
    sync_status: "idle",
    active_sync_id: null,
    last_synced_at: new Date().toISOString(),
    last_sync_error: null,
  });
  return { status: "complete", ...nextCounts };
}

export async function startGitHubSync(
  userId: string,
): Promise<GitHubSyncProgress> {
  const client = createAdminClient();
  const syncId = randomUUID();
  const result = await client.rpc("begin_github_sync", {
    p_user_id: userId,
    p_sync_id: syncId,
  });
  if (result.error) throw result.error;
  if (!result.data)
    return progressForConnection(await loadConnection(client, userId));
  return processPage(client, userId, syncId);
}

export async function continueGitHubSync(
  userId: string,
  syncId: string,
): Promise<GitHubSyncProgress> {
  return processPage(createAdminClient(), userId, syncId);
}
