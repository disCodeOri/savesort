import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  embedDocument: vi.fn(),
  getValidRedditAccessToken: vi.fn(),
  listSavedPostsPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

vi.mock("@/lib/reddit/connections", () => ({
  getValidRedditAccessToken: mocks.getValidRedditAccessToken,
  REDDIT_RECONNECT_MESSAGE: "Reddit needs to be reconnected.",
}));

vi.mock("@/lib/reddit/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reddit/api")>();
  return { ...original, listSavedPostsPage: mocks.listSavedPostsPage };
});

import { RedditApiError } from "@/lib/reddit/api";
import {
  continueRedditSync,
  RedditSyncError,
  startRedditSync,
} from "@/lib/reddit/sync";
import type { RedditSavedPost } from "@/lib/reddit/types";

const USER_ID = "11111111-1111-4111-8111-111111111111";

interface ConnectionRow {
  user_id: string;
  reddit_username: string;
  connection_status: "connected" | "reconnect_required";
  sync_status: "idle" | "running" | "failed";
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

type SavedRow = Record<string, unknown> & {
  user_id: string;
  normalized_url: string;
  updated_at: string;
};

function post(id: string, overrides: Partial<RedditSavedPost> = {}) {
  return {
    id,
    name: `t3_${id}`,
    permalink: `/r/programming/comments/${id}/a_saved_post/`,
    title: `Saved post ${id}`,
    subreddit: "programming",
    subreddit_name_prefixed: "r/programming",
    author: "someone",
    url: `https://example.com/${id}`,
    selftext: "",
    link_flair_text: null,
    thumbnail: "self",
    score: 1,
    num_comments: 0,
    created_utc: 1_700_000_000,
    over_18: false,
    is_self: false,
    ...overrides,
  } satisfies RedditSavedPost;
}

/**
 * A minimal stand-in for the Supabase admin client that enforces the same lease
 * and cursor rules the SQL functions do, so the sync loop is tested honestly.
 */
class AdminClientMock {
  connection: ConnectionRow | null = null;
  readonly savedRows: SavedRow[] = [];
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];
  applyReturnsConflict = false;

  from(table: string) {
    const filters: Array<{ column: string; values: unknown[] }> = [];
    const builder = {
      select: () => builder,
      eq(column: string, value: unknown) {
        filters.push({ column, values: [value] });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        filters.push({ column, values });
        return builder;
      },
      maybeSingle: () => {
        const rows = this.rowsFor(table, filters);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({
          data: this.rowsFor(table, filters),
          error: null,
        }).then(resolve),
    };
    return builder;
  }

  private rowsFor(
    table: string,
    filters: Array<{ column: string; values: unknown[] }>,
  ) {
    const rows: Record<string, unknown>[] =
      table === "reddit_connections"
        ? this.connection
          ? [this.connection as unknown as Record<string, unknown>]
          : []
        : this.savedRows;
    return rows.filter((row) =>
      filters.every((filter) => filter.values.includes(row[filter.column])),
    );
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name === "begin_reddit_sync") return this.begin(values);
    if (name === "claim_reddit_sync_page") return this.claim(values);
    if (name === "heartbeat_reddit_sync_page")
      return Promise.resolve({ data: true, error: null });
    if (name === "apply_reddit_sync_page") return this.apply(values);
    if (name === "fail_reddit_sync_page") return this.fail(values);
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
      next_cursor: null,
      discovered_count: 0,
      saved_count: 0,
      skipped_count: 0,
      sync_started_at: new Date().toISOString(),
      last_sync_error: null,
      page_lease_id: null,
      page_lease_started_at: null,
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
    Object.assign(connection, {
      page_lease_id: values.p_lease_id,
      page_lease_started_at: new Date().toISOString(),
    });
    return Promise.resolve({ data: true, error: null });
  }

  private apply(values: Record<string, unknown>) {
    const connection = this.connection;
    if (
      !connection ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page ||
      connection.page_lease_id !== values.p_lease_id ||
      this.applyReturnsConflict
    ) {
      return Promise.resolve({ data: null, error: null });
    }

    const items = values.p_items as Array<Record<string, unknown>>;
    const nextPage = values.p_next_page as number | null;
    const nextCursor = values.p_next_cursor as string | null;
    if (
      items.length + Number(values.p_skipped_count) !==
      values.p_discovered_count
    ) {
      return Promise.resolve({
        data: null,
        error: { message: "page counts do not balance" },
      });
    }
    if ((nextPage === null) !== (nextCursor === null)) {
      return Promise.resolve({
        data: null,
        error: { message: "next page and cursor disagree" },
      });
    }

    let insertedCount = 0;
    for (const item of items) {
      const { expected_updated_at: expected, ...row } = item;
      const existing = this.savedRows.find(
        (candidate) =>
          candidate.user_id === row.user_id &&
          candidate.normalized_url === row.normalized_url,
      );
      if (!existing && expected === null) {
        this.savedRows.push({
          ...(row as SavedRow),
          updated_at: new Date().toISOString(),
        });
        insertedCount += 1;
      } else if (existing && existing.updated_at === expected) {
        Object.assign(existing, row, {
          updated_at: new Date(Date.now() + 1).toISOString(),
        });
      }
    }

    Object.assign(connection, {
      discovered_count:
        connection.discovered_count + Number(values.p_discovered_count),
      saved_count: connection.saved_count + insertedCount,
      skipped_count: connection.skipped_count + Number(values.p_skipped_count),
      next_cursor: nextCursor,
      page_lease_id: null,
      page_lease_started_at: null,
      last_sync_error: null,
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
        next_cursor: nextCursor,
        discovered_count: connection.discovered_count,
        saved_count: connection.saved_count,
        skipped_count: connection.skipped_count,
      },
      error: null,
    });
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
      sync_status: "failed" as const,
      active_sync_id: null,
      page_lease_id: null,
      page_lease_started_at: null,
      last_sync_error: values.p_error,
    });
    return Promise.resolve({ data: true, error: null });
  }
}

function connectedRow(): ConnectionRow {
  return {
    user_id: USER_ID,
    reddit_username: "savesort_user",
    connection_status: "connected",
    sync_status: "idle",
    active_sync_id: null,
    next_page: 1,
    next_cursor: null,
    discovered_count: 0,
    saved_count: 0,
    skipped_count: 0,
    sync_started_at: null,
    last_synced_at: null,
    last_sync_error: null,
    page_lease_id: null,
    page_lease_started_at: null,
  };
}

let admin: AdminClientMock;

beforeEach(() => {
  admin = new AdminClientMock();
  admin.connection = connectedRow();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.embedDocument.mockReset().mockResolvedValue({ embedding: [0.1, 0.2] });
  mocks.getValidRedditAccessToken.mockReset().mockResolvedValue("access");
  mocks.listSavedPostsPage.mockReset();
});

describe("Reddit sync", () => {
  it("starts from the newest saved item and reports the next page", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a"), post("b")],
      discoveredCount: 2,
      nextCursor: "t3_b",
    });

    const progress = await startRedditSync(USER_ID);

    expect(mocks.listSavedPostsPage).toHaveBeenCalledWith(
      "access",
      "savesort_user",
      null,
    );
    expect(progress).toMatchObject({
      status: "running",
      nextPage: 2,
      discoveredCount: 2,
      savedCount: 2,
      skippedCount: 0,
    });
    expect(admin.connection?.next_cursor).toBe("t3_b");
  });

  it("follows the stored cursor until the listing is exhausted", async () => {
    mocks.listSavedPostsPage
      .mockResolvedValueOnce({
        posts: [post("a")],
        discoveredCount: 1,
        nextCursor: "t3_a",
      })
      .mockResolvedValueOnce({
        posts: [post("b")],
        discoveredCount: 1,
        nextCursor: "t3_b",
      })
      .mockResolvedValueOnce({
        posts: [post("c")],
        discoveredCount: 1,
        nextCursor: null,
      });

    const first = await startRedditSync(USER_ID);
    if (first.status !== "running") throw new Error("expected a running sync");
    const second = await continueRedditSync(USER_ID, first.syncId);
    if (second.status !== "running") throw new Error("expected a running sync");
    const third = await continueRedditSync(USER_ID, second.syncId);

    expect(mocks.listSavedPostsPage.mock.calls.map((call) => call[2])).toEqual([
      null,
      "t3_a",
      "t3_b",
    ]);
    expect(third).toMatchObject({
      status: "complete",
      discoveredCount: 3,
      savedCount: 3,
      skippedCount: 0,
    });
    expect(admin.connection).toMatchObject({
      sync_status: "idle",
      active_sync_id: null,
      next_cursor: null,
    });
    expect(admin.savedRows).toHaveLength(3);
  });

  it("keeps paging through a page that yields no usable posts", async () => {
    mocks.listSavedPostsPage
      .mockResolvedValueOnce({
        posts: [],
        discoveredCount: 4,
        nextCursor: "t3_only_comments",
      })
      .mockResolvedValueOnce({
        posts: [post("a")],
        discoveredCount: 1,
        nextCursor: null,
      });

    const first = await startRedditSync(USER_ID);
    if (first.status !== "running") throw new Error("expected a running sync");
    const second = await continueRedditSync(USER_ID, first.syncId);

    expect(second).toMatchObject({
      status: "complete",
      discoveredCount: 5,
      savedCount: 1,
      skippedCount: 4,
    });
  });

  it("counts a duplicate permalink in one page as skipped", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a"), post("a")],
      discoveredCount: 2,
      nextCursor: null,
    });

    const progress = await startRedditSync(USER_ID);

    expect(progress).toMatchObject({
      status: "complete",
      savedCount: 1,
      skippedCount: 1,
    });
    expect(admin.savedRows).toHaveLength(1);
  });

  it("stores the permalink, subreddit tags and Reddit metadata", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a", { is_self: true, selftext: "Body text", url: null })],
      discoveredCount: 1,
      nextCursor: null,
    });

    await startRedditSync(USER_ID);

    expect(admin.savedRows[0]).toMatchObject({
      source: "reddit",
      url: "https://www.reddit.com/r/programming/comments/a/a_saved_post",
      title: "Saved post a",
      content: "Body text",
      author: "someone",
      tags: ["r/programming"],
      indexing_status: "ready",
    });
  });

  it("preserves user notes and tags when the same post syncs again", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a")],
      discoveredCount: 1,
      nextCursor: null,
    });

    await startRedditSync(USER_ID);
    Object.assign(admin.savedRows[0]!, {
      notes: "Worth rereading",
      tags: ["read-later", "r/programming"],
    });
    admin.connection = connectedRow();

    await startRedditSync(USER_ID);

    expect(admin.savedRows).toHaveLength(1);
    expect(admin.savedRows[0]).toMatchObject({
      notes: "Worth rereading",
      tags: ["read-later", "r/programming"],
    });
  });

  it("falls back to keyword-only indexing when embedding fails", async () => {
    mocks.embedDocument.mockRejectedValue(new Error("gemini down"));
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a")],
      discoveredCount: 1,
      nextCursor: null,
    });

    await startRedditSync(USER_ID);

    expect(admin.savedRows[0]).toMatchObject({
      embedding: null,
      indexing_status: "keyword_only",
      indexing_error: "Semantic indexing is temporarily unavailable.",
    });
  });

  it("asks for a reconnect when Reddit rejects the token", async () => {
    mocks.listSavedPostsPage.mockRejectedValue(
      new RedditApiError("unauthorized"),
    );

    const progress = await startRedditSync(USER_ID);

    expect(progress.status).toBe("reconnect_required");
    expect(admin.connection).toMatchObject({
      connection_status: "reconnect_required",
      sync_status: "failed",
      last_sync_error: "Reddit access expired. Reconnect to resume syncing.",
    });
  });

  it("surfaces rate limiting and leaves the sync failed", async () => {
    mocks.listSavedPostsPage.mockRejectedValue(
      new RedditApiError("rate_limited"),
    );

    await expect(startRedditSync(USER_ID)).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(admin.connection).toMatchObject({
      connection_status: "connected",
      sync_status: "failed",
    });
  });

  it("rejects a continuation for a sync that is no longer active", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a")],
      discoveredCount: 1,
      nextCursor: null,
    });
    await startRedditSync(USER_ID);

    await expect(
      continueRedditSync(USER_ID, "22222222-2222-4222-8222-222222222222"),
    ).rejects.toBeInstanceOf(RedditSyncError);
  });

  it("reports a missing connection instead of calling Reddit", async () => {
    admin.connection = null;

    const progress = await startRedditSync(USER_ID);

    expect(progress).toMatchObject({ status: "not_connected", savedCount: 0 });
    expect(mocks.listSavedPostsPage).not.toHaveBeenCalled();
  });

  it("reports a connection that needs reconnecting without syncing", async () => {
    admin.connection = {
      ...connectedRow(),
      connection_status: "reconnect_required",
    };

    const progress = await startRedditSync(USER_ID);

    expect(progress.status).toBe("reconnect_required");
    expect(mocks.listSavedPostsPage).not.toHaveBeenCalled();
  });

  it("treats a lost page lease as a conflict", async () => {
    mocks.listSavedPostsPage.mockResolvedValue({
      posts: [post("a")],
      discoveredCount: 1,
      nextCursor: null,
    });
    admin.applyReturnsConflict = true;

    await expect(startRedditSync(USER_ID)).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});
