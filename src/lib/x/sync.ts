import "server-only";

import { randomUUID } from "node:crypto";

import { mapWithConcurrency } from "@/lib/async/concurrency";
import { embedDocument } from "@/lib/embeddings/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { listBookmarksPage, XApiError } from "@/lib/x/api";
import {
  getConnectedXUserId,
  getValidXAccessToken,
  X_RECONNECT_MESSAGE,
} from "@/lib/x/connections";
import { mapXBookmark, type XProviderItem } from "@/lib/x/map-bookmark";

const CONNECTION_COLUMNS =
  "user_id, connection_status, sync_status, active_sync_id, next_page, pagination_token, discovered_count, saved_count, updated_count, skipped_count, sync_started_at, last_synced_at, last_sync_error, rate_limit_reset_at, page_lease_id, page_lease_started_at";
const EMBEDDING_CONCURRENCY = 4;
const PAGE_HEARTBEAT_INTERVAL_MS = 60_000;
/**
 * X's bookmarks endpoint has a known habit of paginating far longer than a
 * user could plausibly have bookmarks. This is a hard stop against a cursor
 * that never terminates, which on a pay-per-post API would be a cost bug.
 */
const MAX_PAGES = 60;
const INDEXING_ERROR = "Semantic indexing is temporarily unavailable.";
const RECONNECT_ERROR = "X access expired. Reconnect to resume syncing.";
const UNKNOWN_SYNC_ERROR = "X sync failed. Try again later.";

type AdminClient = ReturnType<typeof createAdminClient>;

interface ConnectionRow {
  user_id: string;
  connection_status: "connected" | "reconnect_required";
  sync_status: "idle" | "running" | "failed" | "rate_limited";
  active_sync_id: string | null;
  next_page: number;
  pagination_token: string | null;
  discovered_count: number;
  saved_count: number;
  updated_count: number;
  skipped_count: number;
  sync_started_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  rate_limit_reset_at: string | null;
  page_lease_id: string | null;
  page_lease_started_at: string | null;
}

interface SyncCounts {
  discoveredCount: number;
  savedCount: number;
  updatedCount: number;
  skippedCount: number;
}

export type XSyncProgress =
  | ({ status: "running"; syncId: string; nextPage: number } & SyncCounts)
  | ({
      status:
        | "complete"
        | "not_connected"
        | "reconnect_required"
        | "failed"
        | "rate_limited";
      /** Only set for rate_limited, so the UI can say when to retry. */
      rateLimitResetAt?: string | null;
      /** True when the traversal reached the end and reconciliation ran. */
      reconciled?: boolean;
      deactivatedCount?: number;
    } & SyncCounts);

export type XSyncErrorKind = "conflict" | "forbidden" | "unavailable";

export class XSyncError extends Error {
  constructor(
    public readonly kind: XSyncErrorKind,
    message?: string,
  ) {
    super(message ?? messageForSyncError(kind));
    this.name = "XSyncError";
  }
}

function messageForSyncError(kind: XSyncErrorKind): string {
  if (kind === "conflict") {
    return "This X sync is no longer active. Start a new sync.";
  }
  if (kind === "forbidden") {
    return "X refused this request.";
  }
  return "X sync is temporarily unavailable. Try again later.";
}

function counts(connection: ConnectionRow | null): SyncCounts {
  return {
    discoveredCount: connection?.discovered_count ?? 0,
    savedCount: connection?.saved_count ?? 0,
    updatedCount: connection?.updated_count ?? 0,
    skippedCount: connection?.skipped_count ?? 0,
  };
}

function terminalProgress(
  status: Exclude<XSyncProgress["status"], "running">,
  connection: ConnectionRow | null,
  extra: Partial<XSyncProgress> = {},
): XSyncProgress {
  return { status, ...counts(connection), ...extra } as XSyncProgress;
}

function progressForConnection(
  connection: ConnectionRow | null,
): XSyncProgress {
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
  if (connection.sync_status === "rate_limited") {
    return terminalProgress("rate_limited", connection, {
      rateLimitResetAt: connection.rate_limit_reset_at,
    });
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
    .from("x_connections")
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
  options: {
    reconnectRequired?: boolean;
    rateLimited?: boolean;
    rateLimitResetAt?: string | null;
  } = {},
): Promise<boolean> {
  try {
    const result = await client.rpc("fail_x_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_page: page,
      p_lease_id: leaseId,
      p_error: error,
      p_reconnect_required: options.reconnectRequired ?? false,
      p_rate_limited: options.rateLimited ?? false,
      p_rate_limit_reset_at: options.rateLimitResetAt ?? null,
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
          const result = await client.rpc("heartbeat_x_sync_page", {
            p_user_id: userId,
            p_sync_id: syncId,
            p_page: page,
            p_lease_id: leaseId,
          });
          if (result.error || result.data !== true) {
            failure = new XSyncError("conflict");
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
): Promise<XSyncProgress> {
  const userId = connection.user_id;

  if (
    (error instanceof XApiError && error.kind === "unauthorized") ||
    (error instanceof Error && error.message === X_RECONNECT_MESSAGE)
  ) {
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      page,
      leaseId,
      RECONNECT_ERROR,
      { reconnectRequired: true },
    );
    if (!cleaned) throw new XSyncError("conflict");
    return terminalProgress("reconnect_required", connection);
  }

  // Rate limiting is not a failure: the cursor is preserved so the next
  // attempt resumes rather than re-reading pages the user already paid for.
  if (error instanceof XApiError && error.kind === "rate_limited") {
    const resetAt = error.rateLimit?.resetAt?.toISOString() ?? null;
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      page,
      leaseId,
      "X rate limit reached. Sync will resume later.",
      { rateLimited: true, rateLimitResetAt: resetAt },
    );
    if (!cleaned) throw new XSyncError("conflict");
    return terminalProgress("rate_limited", connection, {
      rateLimitResetAt: resetAt,
    });
  }

  // A 403 usually means a missing scope or an access tier that cannot read
  // bookmarks. Neither is fixed by retrying, so surface it plainly.
  if (error instanceof XApiError && error.kind === "forbidden") {
    const detail = error.detail ?? "X refused this request.";
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      page,
      leaseId,
      detail.slice(0, 200),
    );
    if (!cleaned) throw new XSyncError("conflict");
    throw new XSyncError("forbidden", detail);
  }

  if (error instanceof XApiError) {
    const syncError = new XSyncError("unavailable");
    const cleaned = await cleanUpFailure(
      client,
      userId,
      syncId,
      page,
      leaseId,
      syncError.message,
    );
    if (!cleaned) throw new XSyncError("conflict");
    throw syncError;
  }

  await cleanUpFailure(
    client,
    userId,
    syncId,
    page,
    leaseId,
    UNKNOWN_SYNC_ERROR,
  );
  throw error;
}

async function prepareRow(
  userId: string,
  item: XProviderItem,
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
    // Keyword search still works without an embedding, so a failed embed must
    // never stop the item being saved.
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
): Promise<XSyncProgress> {
  const connection = await loadConnection(client, userId);
  if (!connection) return terminalProgress("not_connected", null);
  if (connection.connection_status === "reconnect_required") {
    return terminalProgress("reconnect_required", connection);
  }
  if (
    connection.sync_status !== "running" ||
    connection.active_sync_id !== syncId
  ) {
    throw new XSyncError("conflict");
  }

  const page = connection.next_page;
  const requestToken = connection.pagination_token;
  const leaseId = randomUUID();

  const claimed = await client.rpc("claim_x_sync_page", {
    p_user_id: userId,
    p_sync_id: syncId,
    p_page: page,
    p_lease_id: leaseId,
  });
  if (claimed.error || claimed.data !== true) {
    throw new XSyncError("conflict");
  }

  const heartbeat = startPageHeartbeat(client, userId, syncId, page, leaseId);
  try {
    const xUserId = await getConnectedXUserId(userId);
    if (!xUserId) throw new Error(X_RECONNECT_MESSAGE);

    const accessToken = await getValidXAccessToken(userId);
    const bookmarkPage = await listBookmarksPage(
      accessToken,
      xUserId,
      requestToken,
    );

    const items: XProviderItem[] = [];
    const seen = new Set<string>();
    for (const post of bookmarkPage.posts) {
      try {
        const item = mapXBookmark(
          post,
          bookmarkPage.authorsById,
          bookmarkPage.mediaByKey,
          bookmarkPage.referencedPostsById,
        );
        // The same post can appear twice across pages; the first wins.
        if (seen.has(item.normalized_url)) continue;
        seen.add(item.normalized_url);
        items.push(item);
      } catch {
        // A post whose id cannot form a valid URL is not indexable.
      }
    }

    const rows = await mapWithConcurrency(
      items,
      EMBEDDING_CONCURRENCY,
      (item) => prepareRow(userId, item),
    );

    const heartbeatError = await heartbeat.stop();
    if (heartbeatError) throw heartbeatError;

    // A token identical to the one just used would page forever; treating it
    // as the end is both correct and the cheaper failure mode.
    const repeatedToken =
      bookmarkPage.nextToken !== null &&
      bookmarkPage.nextToken === requestToken;
    const hitPageCap = page >= MAX_PAGES;
    const isComplete =
      bookmarkPage.nextToken === null || repeatedToken || hitPageCap;

    const applied = await client.rpc("apply_x_sync_page", {
      p_user_id: userId,
      p_sync_id: syncId,
      p_lease_id: leaseId,
      p_page: page,
      p_next_page: isComplete ? null : page + 1,
      p_pagination_token: isComplete ? null : bookmarkPage.nextToken,
      p_discovered_count: bookmarkPage.resultCount,
      p_skipped_count: bookmarkPage.resultCount - rows.length,
      p_items: rows,
    });
    if (applied.error) throw applied.error;
    if (!applied.data) throw new XSyncError("conflict");

    const result = applied.data as {
      status: "running" | "complete";
      next_page: number | null;
      discovered_count: number;
      saved_count: number;
      updated_count: number;
      skipped_count: number;
    };
    const resultCounts: SyncCounts = {
      discoveredCount: result.discovered_count,
      savedCount: result.saved_count,
      updatedCount: result.updated_count,
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

    // Reconciliation runs only here — on the branch where the traversal
    // genuinely reached the end. Rate limits and failures return earlier, so a
    // partial sync can never deactivate bookmarks it simply never reached.
    // Hitting the page cap is also not a real ending, so it does not reconcile.
    let deactivatedCount = 0;
    let reconciled = false;
    if (!hitPageCap) {
      const reconcile = await client.rpc("reconcile_x_bookmarks", {
        p_user_id: userId,
        p_sync_id: syncId,
      });
      if (!reconcile.error) {
        deactivatedCount = Number(reconcile.data ?? 0);
        reconciled = true;
      }
    }

    return {
      status: "complete",
      ...resultCounts,
      reconciled,
      deactivatedCount,
    };
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

export async function startXSync(userId: string): Promise<XSyncProgress> {
  const client = createAdminClient();
  const syncId = randomUUID();
  const result = await client.rpc("begin_x_sync", {
    p_user_id: userId,
    p_sync_id: syncId,
  });
  if (result.error) {
    await cleanUpFailure(client, userId, syncId, 1, null, UNKNOWN_SYNC_ERROR);
    throw result.error;
  }
  // begin returns false when another sync already holds the connection, which
  // is what stops a double-clicked button launching two paid imports.
  if (!result.data) {
    return progressForConnection(await loadConnection(client, userId));
  }
  return processPage(client, userId, syncId);
}

export async function continueXSync(
  userId: string,
  syncId: string,
): Promise<XSyncProgress> {
  return processPage(createAdminClient(), userId, syncId);
}
