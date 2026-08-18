import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  embedDocument: vi.fn(),
  listBookmarksPage: vi.fn(),
  getValidXAccessToken: vi.fn(),
  getConnectedXUserId: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

vi.mock("@/lib/x/connections", () => ({
  getValidXAccessToken: mocks.getValidXAccessToken,
  getConnectedXUserId: mocks.getConnectedXUserId,
  X_RECONNECT_MESSAGE: "X needs to be reconnected.",
}));

vi.mock("@/lib/x/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/x/api")>();
  return { ...original, listBookmarksPage: mocks.listBookmarksPage };
});

import { XApiError } from "@/lib/x/api";
import { continueXSync, startXSync, XSyncError } from "@/lib/x/sync";
import type { XAccount, XPost } from "@/lib/x/types";

const USER_ID = "11111111-1111-4111-8111-111111111111";

interface BookmarkRow {
  post_id: string;
  saved_item_id: string | null;
  last_seen_sync_id: string | null;
  active: boolean;
}

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

function connectionRow(): ConnectionRow {
  return {
    user_id: USER_ID,
    connection_status: "connected",
    sync_status: "idle",
    active_sync_id: null,
    next_page: 1,
    pagination_token: null,
    discovered_count: 0,
    saved_count: 0,
    updated_count: 0,
    skipped_count: 0,
    sync_started_at: null,
    last_synced_at: null,
    last_sync_error: null,
    rate_limit_reset_at: null,
    page_lease_id: null,
    page_lease_started_at: null,
  };
}

/** Mirrors the lease, cursor and reconciliation rules the SQL enforces. */
class AdminClientMock {
  connection: ConnectionRow | null = connectionRow();
  readonly bookmarks = new Map<string, BookmarkRow>();
  readonly savedUrls = new Set<string>();
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];

  from() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      maybeSingle: () =>
        Promise.resolve({ data: this.connection, error: null }),
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return builder;
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name === "begin_x_sync") return this.begin(values);
    if (name === "claim_x_sync_page") return this.claim(values);
    if (name === "heartbeat_x_sync_page")
      return Promise.resolve({ data: true, error: null });
    if (name === "apply_x_sync_page") return this.apply(values);
    if (name === "reconcile_x_bookmarks") return this.reconcile(values);
    if (name === "fail_x_sync_page") return this.fail(values);
    return Promise.resolve({ data: null, error: { message: "unknown RPC" } });
  }

  private begin(values: Record<string, unknown>) {
    const connection = this.connection;
    if (
      !connection ||
      connection.connection_status !== "connected" ||
      connection.sync_status === "running"
    ) {
      return Promise.resolve({ data: false, error: null });
    }
    Object.assign(connection, {
      sync_status: "running",
      active_sync_id: values.p_sync_id,
      next_page: 1,
      pagination_token: null,
      discovered_count: 0,
      saved_count: 0,
      updated_count: 0,
      skipped_count: 0,
      sync_started_at: new Date().toISOString(),
      last_sync_error: null,
      rate_limit_reset_at: null,
      page_lease_id: null,
    });
    return Promise.resolve({ data: true, error: null });
  }

  private claim(values: Record<string, unknown>) {
    const connection = this.connection;
    if (
      !connection ||
      connection.sync_status !== "running" ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page ||
      connection.page_lease_id !== null
    ) {
      return Promise.resolve({ data: false, error: null });
    }
    connection.page_lease_id = values.p_lease_id as string;
    connection.page_lease_started_at = new Date().toISOString();
    return Promise.resolve({ data: true, error: null });
  }

  private apply(values: Record<string, unknown>) {
    const connection = this.connection;
    if (
      !connection ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page ||
      connection.page_lease_id !== values.p_lease_id
    ) {
      return Promise.resolve({ data: null, error: null });
    }

    const items = values.p_items as Array<Record<string, unknown>>;
    if (
      items.length + Number(values.p_skipped_count) !==
      values.p_discovered_count
    ) {
      return Promise.resolve({
        data: null,
        error: { message: "page counts do not balance" },
      });
    }

    let created = 0;
    let refreshed = 0;
    for (const item of items) {
      const postId = String(item.post_id);
      if (this.bookmarks.has(postId)) refreshed += 1;
      else created += 1;
      this.savedUrls.add(String(item.normalized_url));
      this.bookmarks.set(postId, {
        post_id: postId,
        saved_item_id: `item-${postId}`,
        last_seen_sync_id: String(values.p_sync_id),
        active: true,
      });
    }

    const nextPage = values.p_next_page as number | null;
    Object.assign(connection, {
      discovered_count:
        connection.discovered_count + Number(values.p_discovered_count),
      saved_count: connection.saved_count + created,
      updated_count: connection.updated_count + refreshed,
      skipped_count: connection.skipped_count + Number(values.p_skipped_count),
      pagination_token: values.p_pagination_token as string | null,
      page_lease_id: null,
      ...(nextPage === null
        ? {
            sync_status: "idle" as const,
            active_sync_id: null,
            last_synced_at: new Date().toISOString(),
          }
        : { next_page: nextPage }),
    });

    return Promise.resolve({
      data: {
        status: nextPage === null ? "complete" : "running",
        next_page: nextPage,
        discovered_count: connection.discovered_count,
        saved_count: connection.saved_count,
        updated_count: connection.updated_count,
        skipped_count: connection.skipped_count,
      },
      error: null,
    });
  }

  private reconcile(values: Record<string, unknown>) {
    let deactivated = 0;
    for (const row of this.bookmarks.values()) {
      if (row.active && row.last_seen_sync_id !== values.p_sync_id) {
        row.active = false;
        deactivated += 1;
      }
    }
    return Promise.resolve({ data: deactivated, error: null });
  }

  private fail(values: Record<string, unknown>) {
    const connection = this.connection;
    if (
      !connection ||
      connection.sync_status !== "running" ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page
    ) {
      return Promise.resolve({ data: false, error: null });
    }
    Object.assign(connection, {
      connection_status: values.p_reconnect_required
        ? ("reconnect_required" as const)
        : connection.connection_status,
      sync_status: values.p_rate_limited
        ? ("rate_limited" as const)
        : ("failed" as const),
      active_sync_id: null,
      page_lease_id: null,
      last_sync_error: values.p_error,
      rate_limit_reset_at: values.p_rate_limit_reset_at as string | null,
    });
    return Promise.resolve({ data: true, error: null });
  }
}

function post(id: string): XPost {
  return {
    id,
    text: `Post ${id} about retrieval pipelines`,
    authorId: "a1",
    createdAt: "2026-02-01T00:00:00.000Z",
    lang: "en",
    conversationId: id,
    urls: [],
    mediaKeys: [],
    referencedPostIds: [],
  };
}

const author: XAccount = {
  id: "a1",
  username: "someone",
  name: "Some One",
  profileImageUrl: null,
};

function page(posts: XPost[], nextToken: string | null) {
  return {
    posts,
    authorsById: new Map([["a1", author]]),
    mediaByKey: new Map(),
    referencedPostsById: new Map(),
    nextToken,
    resultCount: posts.length,
  };
}

let admin: AdminClientMock;

beforeEach(() => {
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.embedDocument
    .mockReset()
    .mockResolvedValue({ embedding: [0.1, 0.2], error: null });
  mocks.getValidXAccessToken.mockReset().mockResolvedValue("access-token");
  mocks.getConnectedXUserId.mockReset().mockResolvedValue("42");
  mocks.listBookmarksPage.mockReset();
});

describe("X sync pagination", () => {
  it("imports a single page and completes", async () => {
    mocks.listBookmarksPage.mockResolvedValue(
      page([post("1"), post("2")], null),
    );

    const progress = await startXSync(USER_ID);

    expect(progress).toMatchObject({
      status: "complete",
      savedCount: 2,
      discoveredCount: 2,
    });
    expect(admin.bookmarks.size).toBe(2);
  });

  it("follows the pagination token across pages", async () => {
    mocks.listBookmarksPage
      .mockResolvedValueOnce(page([post("1")], "T2"))
      .mockResolvedValueOnce(page([post("2")], "T3"))
      .mockResolvedValueOnce(page([post("3")], null));

    const first = await startXSync(USER_ID);
    if (first.status !== "running") throw new Error("expected running");
    const second = await continueXSync(USER_ID, first.syncId);
    if (second.status !== "running") throw new Error("expected running");
    const third = await continueXSync(USER_ID, second.syncId);

    expect(mocks.listBookmarksPage.mock.calls.map((call) => call[2])).toEqual([
      null,
      "T2",
      "T3",
    ]);
    expect(third).toMatchObject({ status: "complete", savedCount: 3 });
  });

  it("stops when the pagination token repeats instead of looping forever", async () => {
    // A cursor that never advances would bill per page indefinitely.
    mocks.listBookmarksPage
      .mockResolvedValueOnce(page([post("1")], "SAME"))
      .mockResolvedValueOnce(page([post("2")], "SAME"));

    const first = await startXSync(USER_ID);
    if (first.status !== "running") throw new Error("expected running");
    const second = await continueXSync(USER_ID, first.syncId);

    expect(second.status).toBe("complete");
    expect(mocks.listBookmarksPage).toHaveBeenCalledTimes(2);
  });

  it("handles an empty bookmark list", async () => {
    mocks.listBookmarksPage.mockResolvedValue(page([], null));

    const progress = await startXSync(USER_ID);

    expect(progress).toMatchObject({ status: "complete", savedCount: 0 });
  });
});

describe("X sync idempotency", () => {
  it("does not duplicate items when the same post is synced again", async () => {
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], null));
    await startXSync(USER_ID);

    admin.connection = { ...connectionRow() };
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], null));
    const second = await startXSync(USER_ID);

    expect(admin.bookmarks.size).toBe(1);
    expect(admin.savedUrls.size).toBe(1);
    // The second pass refreshes rather than creating.
    expect(second).toMatchObject({ savedCount: 0, updatedCount: 1 });
  });

  it("deduplicates a post repeated within one page", async () => {
    mocks.listBookmarksPage.mockResolvedValue(
      page([post("1"), post("1")], null),
    );

    const progress = await startXSync(USER_ID);

    expect(admin.bookmarks.size).toBe(1);
    expect(progress).toMatchObject({ savedCount: 1, skippedCount: 1 });
  });

  it("refuses a second concurrent sync for the same user", async () => {
    // begin returns false while a sync already holds the connection, so a
    // double-clicked button cannot launch two paid imports.
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], "T2"));
    const first = await startXSync(USER_ID);
    expect(first.status).toBe("running");

    const second = await startXSync(USER_ID);

    expect(second.status).toBe("running");
    if (first.status !== "running" || second.status !== "running") {
      throw new Error("expected both running");
    }
    expect(second.syncId).toBe(first.syncId);
  });

  it("rejects a continuation for a sync that is no longer active", async () => {
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], null));
    await startXSync(USER_ID);

    await expect(
      continueXSync(USER_ID, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toBeInstanceOf(XSyncError);
  });
});

describe("X sync reconciliation", () => {
  it("deactivates a bookmark removed on X after a complete traversal", async () => {
    mocks.listBookmarksPage.mockResolvedValue(
      page([post("1"), post("2")], null),
    );
    await startXSync(USER_ID);

    // Post 2 is no longer bookmarked on the next full sync.
    admin.connection = { ...connectionRow() };
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], null));
    const progress = await startXSync(USER_ID);

    expect(progress).toMatchObject({ reconciled: true, deactivatedCount: 1 });
    expect(admin.bookmarks.get("2")!.active).toBe(false);
    // The saved item itself is never removed.
    expect(admin.bookmarks.get("2")!.saved_item_id).toBe("item-2");
    expect(admin.savedUrls.size).toBe(2);
  });

  it("never reconciles after a rate-limited sync", async () => {
    // The traversal did not finish, so unseen bookmarks must not be treated
    // as removed.
    mocks.listBookmarksPage.mockResolvedValue(
      page([post("1"), post("2")], null),
    );
    await startXSync(USER_ID);

    admin.connection = { ...connectionRow() };
    mocks.listBookmarksPage.mockRejectedValue(
      new XApiError("rate_limited", {
        limit: 75,
        remaining: 0,
        resetAt: new Date("2026-02-01T01:00:00.000Z"),
      }),
    );
    const progress = await startXSync(USER_ID);

    expect(progress.status).toBe("rate_limited");
    expect(
      admin.rpcCalls.some(
        (call) =>
          call.name === "reconcile_x_bookmarks" &&
          call.values.p_sync_id === admin.connection?.active_sync_id,
      ),
    ).toBe(false);
    expect(admin.bookmarks.get("2")!.active).toBe(true);
  });

  it("never reconciles when a middle page fails", async () => {
    mocks.listBookmarksPage.mockResolvedValue(
      page([post("1"), post("2")], null),
    );
    await startXSync(USER_ID);
    const reconcileCallsBefore = admin.rpcCalls.filter(
      (call) => call.name === "reconcile_x_bookmarks",
    ).length;

    admin.connection = { ...connectionRow() };
    mocks.listBookmarksPage
      .mockResolvedValueOnce(page([post("1")], "T2"))
      .mockRejectedValueOnce(new XApiError("provider_error"));

    const first = await startXSync(USER_ID);
    if (first.status !== "running") throw new Error("expected running");
    await expect(continueXSync(USER_ID, first.syncId)).rejects.toBeInstanceOf(
      XSyncError,
    );

    const reconcileCallsAfter = admin.rpcCalls.filter(
      (call) => call.name === "reconcile_x_bookmarks",
    ).length;
    expect(reconcileCallsAfter).toBe(reconcileCallsBefore);
    expect(admin.bookmarks.get("2")!.active).toBe(true);
  });
});

describe("X sync error handling", () => {
  it("marks the connection reconnect_required on an unauthorized response", async () => {
    mocks.listBookmarksPage.mockRejectedValue(new XApiError("unauthorized"));

    const progress = await startXSync(USER_ID);

    expect(progress.status).toBe("reconnect_required");
    expect(admin.connection).toMatchObject({
      connection_status: "reconnect_required",
      sync_status: "failed",
    });
  });

  it("persists the rate-limit reset time so the UI can explain the wait", async () => {
    mocks.listBookmarksPage.mockRejectedValue(
      new XApiError("rate_limited", {
        limit: 75,
        remaining: 0,
        resetAt: new Date("2026-02-01T01:00:00.000Z"),
      }),
    );

    const progress = await startXSync(USER_ID);

    expect(progress).toMatchObject({
      status: "rate_limited",
      rateLimitResetAt: "2026-02-01T01:00:00.000Z",
    });
    expect(admin.connection?.rate_limit_reset_at).toBe(
      "2026-02-01T01:00:00.000Z",
    );
    // The cursor is kept so the retry resumes instead of re-paying.
    expect(admin.connection?.sync_status).toBe("rate_limited");
  });

  it("surfaces an actionable message for a forbidden response", async () => {
    mocks.listBookmarksPage.mockRejectedValue(
      new XApiError(
        "forbidden",
        null,
        "Your X API access level does not permit reading bookmarks.",
      ),
    );

    await expect(startXSync(USER_ID)).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("keeps items searchable by keyword when embedding fails", async () => {
    mocks.embedDocument.mockResolvedValue({ embedding: null, error: "down" });
    mocks.listBookmarksPage.mockResolvedValue(page([post("1")], null));

    const progress = await startXSync(USER_ID);

    expect(progress.status).toBe("complete");
    const applied = admin.rpcCalls.find(
      (call) => call.name === "apply_x_sync_page",
    )!;
    const items = applied.values.p_items as Array<Record<string, unknown>>;
    expect(items[0]!.indexing_status).toBe("keyword_only");
    expect(items[0]!.searchable_text).toContain("retrieval pipelines");
  });

  it("reports a missing connection without calling X", async () => {
    admin.connection = null;

    const progress = await startXSync(USER_ID);

    expect(progress.status).toBe("not_connected");
    expect(mocks.listBookmarksPage).not.toHaveBeenCalled();
  });
});
