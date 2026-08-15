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
  "user_id, connection_status, sync_status, active_sync_id, next_page, discovered_count, saved_count, skipped_count, sync_started_at, last_synced_at, last_sync_error, page_lease_id, page_lease_started_at";
const SAVED_ITEM_COLUMNS =
  "user_id, url, normalized_url, source, title, description, notes, content, author, thumbnail_url, tags, metadata, searchable_text, embedding, indexing_status, indexing_error, updated_at";
const EMBEDDING_CONCURRENCY = 4;
const EXISTING_ITEM_CHUNK_SIZE = 25;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";
const RECONNECT_ERROR = "GitHub access expired. Reconnect to resume syncing.";
const UNKNOWN_SYNC_ERROR = "GitHub sync failed. Try again later.";

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
  discovered_count: number;
  saved_count: number;
  skipped_count: number;
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

async function claimPageLease(
  client: AdminClient,
  userId: string,
  syncId: string,
  page: number,
  leaseId: string,
): Promise<void> {
  const result = await client.rpc("claim_github_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
  });
  if (result.error) throw result.error;
  if (result.data !== true) throw new GitHubSyncError("conflict");
}

async function failPageLease(
  client: AdminClient,
  userId: string,
  syncId: string,
  leaseId: string | null,
  error: string,
  reconnectRequired: boolean,
): Promise<boolean> {
  const result = await client.rpc("fail_github_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
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
  leaseId: string | null,
  error: string,
  reconnectRequired = false,
): Promise<boolean> {
  try {
    return await failPageLease(
      client,
      userId,
      syncId,
      leaseId,
      error,
      reconnectRequired,
    );
  } catch {
    return false;
  }
}

async function handlePageError(
  client: AdminClient,
  connection: ConnectionRow,
  syncId: string,
  leaseId: string,
  error: unknown,
): Promise<GitHubSyncProgress> {
  if (
    (error instanceof GitHubApiError && error.kind === "unauthorized") ||
    (error instanceof Error &&
      error.message === "GitHub needs to be reconnected.")
  ) {
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      leaseId,
      RECONNECT_ERROR,
      true,
    );
    if (!cleaned) throw new GitHubSyncError("conflict");
    return terminalProgress("reconnect_required", connection);
  }
  if (error instanceof GitHubApiError && error.kind === "rate_limited") {
    const syncError = new GitHubSyncError("rate_limited");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new GitHubSyncError("conflict");
    throw syncError;
  }
  if (error instanceof GitHubApiError && error.kind === "provider_error") {
    const syncError = new GitHubSyncError("unavailable");
    const cleaned = await cleanUpFailure(
      client,
      connection.user_id,
      syncId,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new GitHubSyncError("conflict");
    throw syncError;
  }
  await cleanUpFailure(
    client,
    connection.user_id,
    syncId,
    leaseId,
    UNKNOWN_SYNC_ERROR,
  );
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
): Promise<GitHubSyncProgress> {
  let connection: ConnectionRow | null;
  try {
    connection = await loadConnection(client, userId);
  } catch (error) {
    await cleanUpFailure(client, userId, syncId, null, UNKNOWN_SYNC_ERROR);
    throw error;
  }
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

  const page = connection.next_page;
  const leaseId = randomUUID();
  try {
    await claimPageLease(client, userId, syncId, page, leaseId);
  } catch (error) {
    if (error instanceof GitHubSyncError && error.kind === "conflict") {
      throw error;
    }
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      leaseId,
      UNKNOWN_SYNC_ERROR,
    );
    if (!cleaned) {
      await cleanUpFailure(client, userId, syncId, null, UNKNOWN_SYNC_ERROR);
    }
    throw error;
  }

  try {
    const accessToken = await getValidGitHubAccessToken(userId);
    const providerPage = await listStarredRepositoriesPage(accessToken, page);
    const mapped = mapRepositories(providerPage.repositories);
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
    const applied = await client.rpc("apply_github_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_lease_id: leaseId,
      p_page: page,
      p_next_page: providerPage.nextPage,
      p_discovered_count: providerPage.repositories.length,
      p_skipped_count: mapped.skippedCount,
      p_items: rows,
    });
    if (applied.error) throw applied.error;
    if (!applied.data) throw new GitHubSyncError("conflict");

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
    throw new Error("GitHub sync returned invalid progress.");
  } catch (error) {
    return handlePageError(client, connection, syncId, leaseId, error);
  }
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
  if (result.error) {
    await cleanUpFailure(client, userId, syncId, null, UNKNOWN_SYNC_ERROR);
    throw result.error;
  }
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
