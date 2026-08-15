import { buildSearchableText } from "@/lib/search/searchable-text";
import type { GitHubStarredRepository } from "@/lib/github/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  embedDocument: vi.fn(),
  getValidGitHubAccessToken: vi.fn(),
  listStarredRepositoriesPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/embeddings/gemini", () => ({
  embedDocument: mocks.embedDocument,
}));

vi.mock("@/lib/github/connections", () => ({
  getValidGitHubAccessToken: mocks.getValidGitHubAccessToken,
}));

vi.mock("@/lib/github/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/github/api")>();
  return {
    ...original,
    listStarredRepositoriesPage: mocks.listStarredRepositoriesPage,
  };
});

import { GitHubApiError } from "@/lib/github/api";
import { mapWithConcurrency } from "@/lib/github/concurrency";
import {
  continueGitHubSync,
  GitHubSyncError,
  startGitHubSync,
} from "@/lib/github/sync";

type ConnectionRow = {
  user_id: string;
  connection_status: "connected" | "reconnect_required";
  sync_status: "idle" | "running" | "failed";
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
};

type SavedRow = {
  id: string;
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
  updated_at: string;
};

type QueryOperation = "select" | "update" | "upsert" | "delete";

type QueryCall = {
  table: string;
  operation: QueryOperation;
  filters: Array<
    | { kind: "eq"; column: string; value: unknown }
    | { kind: "in"; column: string; values: unknown[] }
  >;
  values?: Record<string, unknown> | Record<string, unknown>[];
  options?: Record<string, unknown>;
};

type DatabaseResult = { data: unknown; error: { message: string } | null };

class QueryMock implements PromiseLike<DatabaseResult> {
  private operation: QueryOperation = "select";
  private readonly filters: QueryCall["filters"] = [];
  private values?: QueryCall["values"];
  private options?: Record<string, unknown>;

  constructor(
    private readonly admin: AdminClientMock,
    private readonly table: string,
  ) {}

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ kind: "in", column, values });
    return this;
  }

  maybeSingle(): Promise<DatabaseResult> {
    const result = this.execute();
    if (Array.isArray(result.data)) {
      return Promise.resolve({ ...result, data: result.data[0] ?? null });
    }
    return Promise.resolve(result);
  }

  select(columns: string) {
    void columns;
    return this;
  }

  then<TResult1 = DatabaseResult, TResult2 = never>(
    onfulfilled?:
      ((value: DatabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  update(values: Record<string, unknown>) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) {
    this.operation = "upsert";
    this.values = values;
    this.options = options;
    return this;
  }

  private execute(): DatabaseResult {
    const call: QueryCall = {
      table: this.table,
      operation: this.operation,
      filters: [...this.filters],
      ...(this.values === undefined ? {} : { values: this.values }),
      ...(this.options === undefined ? {} : { options: this.options }),
    };
    this.admin.calls.push(call);
    return this.admin.execute(call);
  }
}

class AdminClientMock {
  readonly calls: QueryCall[] = [];
  readonly connections = new Map<string, ConnectionRow>();
  readonly savedRows: SavedRow[] = [];
  readonly rpcCalls: Array<{
    name: string;
    values: Record<string, unknown>;
  }> = [];
  beforeConnectionUpdate: (() => void) | null = null;
  beforePageClaim: (() => void) | null = null;
  beforeItemPersistence: (() => void) | null = null;
  failBeginAfterCommit = false;
  failConnectionSelectOnce = false;
  failPageApply = false;
  failSavedItemsUpsert = false;

  from(table: string) {
    return new QueryMock(this, table);
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    if (name === "begin_github_sync") return this.beginSync(values);
    if (name === "claim_github_sync_page") return this.claimPage(values);
    if (name === "apply_github_sync_page") return this.applyPage(values);
    if (name === "fail_github_sync_page") return this.failPage(values);
    return Promise.resolve({ data: null, error: { message: "unknown RPC" } });
  }

  private beginSync(values: Record<string, unknown>) {
    const userId = String(values.p_user_id);
    const syncId = String(values.p_sync_id);
    const connection = this.connections.get(userId);
    const stale =
      connection?.sync_started_at !== null &&
      connection?.sync_started_at !== undefined &&
      Date.parse(connection.sync_started_at) < Date.now() - 10 * 60 * 1_000;
    if (
      !connection ||
      connection.connection_status !== "connected" ||
      (connection.sync_status === "running" && !stale)
    ) {
      return Promise.resolve({ data: false, error: null });
    }

    Object.assign(connection, {
      sync_status: "running",
      active_sync_id: syncId,
      next_page: 1,
      discovered_count: 0,
      saved_count: 0,
      skipped_count: 0,
      sync_started_at: new Date().toISOString(),
      last_sync_error: null,
      page_lease_id: null,
      page_lease_started_at: null,
    });
    if (this.failBeginAfterCommit) {
      return Promise.resolve({
        data: null,
        error: { message: "begin response failed" },
      });
    }
    return Promise.resolve({ data: true, error: null });
  }

  private claimPage(values: Record<string, unknown>) {
    this.beforePageClaim?.();
    const connection = this.connections.get(String(values.p_user_id));
    const staleLease =
      connection?.page_lease_started_at !== null &&
      connection?.page_lease_started_at !== undefined &&
      Date.parse(connection.page_lease_started_at) <
        Date.now() - 10 * 60 * 1_000;
    if (
      !connection ||
      connection.connection_status !== "connected" ||
      connection.sync_status !== "running" ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page ||
      (connection.page_lease_id !== null && !staleLease)
    ) {
      return Promise.resolve({ data: false, error: null });
    }

    const now = new Date().toISOString();
    Object.assign(connection, {
      page_lease_id: values.p_lease_id,
      page_lease_started_at: now,
      sync_started_at: now,
    });
    return Promise.resolve({ data: true, error: null });
  }

  private applyPage(values: Record<string, unknown>) {
    this.beforeItemPersistence?.();
    const connection = this.connections.get(String(values.p_user_id));
    if (
      !connection ||
      connection.connection_status !== "connected" ||
      connection.sync_status !== "running" ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.next_page !== values.p_page ||
      connection.page_lease_id !== values.p_lease_id
    ) {
      return Promise.resolve({ data: null, error: null });
    }
    if (this.failPageApply) {
      return Promise.resolve({
        data: null,
        error: { message: "atomic page apply failed" },
      });
    }

    const nextRows = this.savedRows.map((row) => structuredClone(row));
    let insertedCount = 0;
    for (const value of values.p_items as Array<Record<string, unknown>>) {
      const existing = nextRows.find(
        (candidate) =>
          candidate.user_id === value.user_id &&
          candidate.normalized_url === value.normalized_url,
      );
      const expectedUpdatedAt = value.expected_updated_at;
      const { expected_updated_at: _expectedUpdatedAt, ...savedValue } = value;
      void _expectedUpdatedAt;
      if (!existing && expectedUpdatedAt === null) {
        nextRows.push({
          id: `item-${nextRows.length + 1}`,
          ...(savedValue as Omit<SavedRow, "id" | "updated_at">),
          updated_at: new Date().toISOString(),
        });
        insertedCount += 1;
      } else if (
        existing &&
        typeof expectedUpdatedAt === "string" &&
        existing.updated_at === expectedUpdatedAt
      ) {
        Object.assign(existing, savedValue, {
          updated_at: new Date(Date.now() + 1).toISOString(),
        });
      }
    }

    this.savedRows.splice(0, this.savedRows.length, ...nextRows);
    const nextPage = values.p_next_page as number | null;
    const now = new Date().toISOString();
    Object.assign(connection, {
      discovered_count:
        connection.discovered_count + Number(values.p_discovered_count),
      saved_count: connection.saved_count + insertedCount,
      skipped_count: connection.skipped_count + Number(values.p_skipped_count),
      page_lease_id: null,
      page_lease_started_at: null,
      sync_started_at: now,
      last_sync_error: null,
      ...(nextPage === null
        ? {
            sync_status: "idle",
            active_sync_id: null,
            last_synced_at: now,
          }
        : { next_page: nextPage }),
    });
    return Promise.resolve({
      data: {
        status: nextPage === null ? "complete" : "running",
        next_page: nextPage,
        discovered_count: connection.discovered_count,
        saved_count: connection.saved_count,
        skipped_count: connection.skipped_count,
      },
      error: null,
    });
  }

  private failPage(values: Record<string, unknown>) {
    const connection = this.connections.get(String(values.p_user_id));
    if (
      !connection ||
      connection.sync_status !== "running" ||
      connection.active_sync_id !== values.p_sync_id ||
      connection.page_lease_id !== values.p_lease_id
    ) {
      return Promise.resolve({ data: false, error: null });
    }
    Object.assign(connection, {
      connection_status: values.p_reconnect_required
        ? "reconnect_required"
        : connection.connection_status,
      sync_status: "failed",
      active_sync_id: null,
      page_lease_id: null,
      page_lease_started_at: null,
      last_sync_error: values.p_error,
    });
    return Promise.resolve({ data: true, error: null });
  }

  execute(call: QueryCall): DatabaseResult {
    if (call.table === "github_connections") {
      return this.executeConnection(call);
    }
    if (call.table === "saved_items") {
      return this.executeSavedItems(call);
    }
    return { data: null, error: { message: "unexpected table" } };
  }

  private executeConnection(call: QueryCall): DatabaseResult {
    if (call.operation === "update") this.beforeConnectionUpdate?.();
    if (call.operation === "select" && this.failConnectionSelectOnce) {
      this.failConnectionSelectOnce = false;
      return { data: null, error: { message: "connection read failed" } };
    }
    const rows = [...this.connections.values()].filter((row) =>
      matches(row as unknown as Record<string, unknown>, call.filters),
    );
    if (call.operation === "select") return { data: rows, error: null };
    if (call.operation === "update") {
      for (const row of rows) Object.assign(row, call.values);
      return { data: rows, error: null };
    }
    return { data: null, error: { message: "unsupported connection write" } };
  }

  private executeSavedItems(call: QueryCall): DatabaseResult {
    if (call.operation === "select") {
      return {
        data: this.savedRows.filter((row) =>
          matches(row as unknown as Record<string, unknown>, call.filters),
        ),
        error: null,
      };
    }
    if (call.operation === "upsert") {
      this.beforeItemPersistence?.();
      if (this.failSavedItemsUpsert) {
        return { data: null, error: { message: "database details" } };
      }
      const values = Array.isArray(call.values) ? call.values : [call.values!];
      for (const value of values) {
        const row = value as Omit<SavedRow, "id">;
        const existing = this.savedRows.find(
          (candidate) =>
            candidate.user_id === row.user_id &&
            candidate.normalized_url === row.normalized_url,
        );
        if (existing) Object.assign(existing, row);
        else
          this.savedRows.push({
            id: `item-${this.savedRows.length + 1}`,
            ...row,
            updated_at: new Date().toISOString(),
          });
      }
      return { data: values, error: null };
    }
    if (call.operation === "delete") {
      return { data: null, error: { message: "sync must not delete items" } };
    }
    return { data: null, error: { message: "unsupported saved item write" } };
  }
}

function matches(
  row: Record<string, unknown>,
  filters: QueryCall["filters"],
): boolean {
  return filters.every((filter) => {
    if (filter.kind === "eq") return row[filter.column] === filter.value;
    return filter.values.includes(row[filter.column]);
  });
}

const userId = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";

function connected(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    user_id: userId,
    connection_status: "connected",
    sync_status: "idle",
    active_sync_id: null,
    next_page: 1,
    discovered_count: 0,
    saved_count: 0,
    skipped_count: 0,
    sync_started_at: null,
    last_synced_at: null,
    last_sync_error: null,
    page_lease_id: null,
    page_lease_started_at: null,
    ...overrides,
  };
}

function star(id: number): GitHubStarredRepository {
  return {
    starred_at: "2026-08-15T10:30:00Z",
    repo: {
      id,
      name: `repo-${id}`,
      full_name: `acme/repo-${id}`,
      html_url: `https://github.com/acme/repo-${id}`,
      description: `Repository ${id}`,
      homepage: null,
      language: "TypeScript",
      topics: ["search"],
      stargazers_count: id,
      forks_count: 2,
      archived: false,
      visibility: "public",
      owner: { login: "acme" },
      license: { spdx_id: "MIT" },
    },
  };
}

function queuePages(
  ...pages: Array<{
    repositories: GitHubStarredRepository[];
    nextPage: number | null;
  }>
) {
  for (const page of pages) {
    mocks.listStarredRepositoriesPage.mockResolvedValueOnce(page);
  }
}

describe("mapWithConcurrency", () => {
  it("preserves result order while never starting more than four workers", async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];

    const resultPromise = mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      4,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return value * 10;
      },
    );

    await vi.waitFor(() => expect(gates).toHaveLength(4));
    gates.splice(0, 4).forEach((release) => release());
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates.splice(0, 2).forEach((release) => release());

    await expect(resultPromise).resolves.toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(4);
  });

  it("rejects concurrency limits below one", async () => {
    await expect(
      mapWithConcurrency([1], 0, async (value) => value),
    ).rejects.toThrow("Concurrency limit must be at least one.");
  });
});

describe("GitHub star synchronization", () => {
  let admin: AdminClientMock;

  beforeEach(() => {
    admin = new AdminClientMock();
    admin.connections.set(userId, connected());
    mocks.createAdminClient.mockReset().mockReturnValue(admin);
    mocks.embedDocument.mockReset().mockResolvedValue({
      embedding: [0.25, 0.5],
      error: null,
    });
    mocks.getValidGitHubAccessToken
      .mockReset()
      .mockResolvedValue("github-access-token");
    mocks.listStarredRepositoriesPage.mockReset();
  });

  it("processes one page per call and completes only after the short page", async () => {
    queuePages(
      {
        repositories: Array.from({ length: 100 }, (_, index) =>
          star(index + 1),
        ),
        nextPage: 2,
      },
      { repositories: [star(101), star(102)], nextPage: null },
    );

    const running = await startGitHubSync(userId);

    expect(running).toMatchObject({
      status: "running",
      nextPage: 2,
      discoveredCount: 100,
      savedCount: 100,
      skippedCount: 0,
    });
    if (running.status !== "running") throw new Error("expected running sync");
    expect(mocks.listStarredRepositoriesPage).toHaveBeenCalledTimes(1);
    expect(mocks.listStarredRepositoriesPage).toHaveBeenLastCalledWith(
      "github-access-token",
      1,
    );

    const complete = await continueGitHubSync(userId, running.syncId);

    expect(complete).toEqual({
      status: "complete",
      discoveredCount: 102,
      savedCount: 102,
      skippedCount: 0,
    });
    expect(mocks.listStarredRepositoriesPage).toHaveBeenCalledTimes(2);
    expect(mocks.listStarredRepositoriesPage).toHaveBeenLastCalledWith(
      "github-access-token",
      2,
    );
    expect(complete).not.toHaveProperty("syncId");
    expect(complete).not.toHaveProperty("nextPage");
  });

  it("returns the active progress instead of starting a second concurrent sync", async () => {
    const activeSyncId = "a48852ad-28c7-418d-bf4d-35b882e8d0e8";
    admin.connections.set(
      userId,
      connected({
        sync_status: "running",
        active_sync_id: activeSyncId,
        next_page: 3,
        discovered_count: 200,
        saved_count: 150,
        skipped_count: 2,
        sync_started_at: new Date().toISOString(),
      }),
    );

    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "running",
      syncId: activeSyncId,
      nextPage: 3,
      discoveredCount: 200,
      savedCount: 150,
      skippedCount: 2,
    });
    expect(mocks.listStarredRepositoriesPage).not.toHaveBeenCalled();
  });

  it("recovers a stale database lock and starts again from page one", async () => {
    const staleSyncId = "bf43e612-a273-494d-a626-1c8555dd60fe";
    admin.connections.set(
      userId,
      connected({
        sync_status: "running",
        active_sync_id: staleSyncId,
        next_page: 8,
        discovered_count: 700,
        sync_started_at: new Date(Date.now() - 11 * 60 * 1_000).toISOString(),
      }),
    );
    queuePages({ repositories: [], nextPage: null });

    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "complete",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });
    expect(admin.rpcCalls[0]).toMatchObject({
      name: "begin_github_sync",
      values: { p_user_id: userId },
    });
    expect(admin.rpcCalls[0]?.values.p_sync_id).not.toBe(staleSyncId);
    expect(mocks.listStarredRepositoriesPage).toHaveBeenCalledWith(
      "github-access-token",
      1,
    );
  });

  it("is idempotent and preserves user-owned fields and unchanged embeddings", async () => {
    queuePages(
      { repositories: [star(1), star(2)], nextPage: null },
      { repositories: [star(1), star(2)], nextPage: null },
    );

    const firstRun = await startGitHubSync(userId);
    const firstRow = admin.savedRows[0]!;
    firstRow.notes = "keep my note";
    firstRow.content = "keep my content";
    firstRow.tags = ["personal", "search", "TypeScript"];
    firstRow.searchable_text = buildSearchableText(firstRow);
    firstRow.embedding = [9, 9];
    firstRow.indexing_status = "ready";
    mocks.embedDocument.mockClear();

    const secondRun = await startGitHubSync(userId);

    expect(firstRun.savedCount).toBe(2);
    expect(secondRun.savedCount).toBe(0);
    expect(admin.savedRows).toHaveLength(2);
    expect(admin.savedRows[0]?.notes).toBe("keep my note");
    expect(admin.savedRows[0]?.content).toBe("keep my content");
    expect(admin.savedRows[0]?.tags).toContain("personal");
    expect(admin.savedRows[0]?.embedding).toEqual([9, 9]);
    expect(mocks.embedDocument).not.toHaveBeenCalled();

    expect(
      admin.calls.filter(
        (call) => call.table === "saved_items" && call.operation === "upsert",
      ),
    ).toHaveLength(0);
    expect(admin.savedRows.every((row) => row.user_id === userId)).toBe(true);
    expect(admin.calls.some((call) => call.operation === "delete")).toBe(false);
  });

  it("refreshes the embedding only when searchable provider data changes", async () => {
    queuePages(
      { repositories: [star(1)], nextPage: null },
      {
        repositories: [
          {
            ...star(1),
            repo: { ...star(1).repo, description: "A changed description" },
          },
        ],
        nextPage: null,
      },
    );

    await startGitHubSync(userId);
    mocks.embedDocument.mockClear();
    await startGitHubSync(userId);

    expect(mocks.embedDocument).toHaveBeenCalledTimes(1);
    expect(admin.savedRows[0]?.description).toBe("A changed description");
  });

  it("saves keyword-searchable rows when embedding generation rejects", async () => {
    mocks.embedDocument.mockRejectedValue(
      new Error("secret Gemini response must not escape"),
    );
    queuePages({ repositories: [star(1)], nextPage: null });

    const progress = await startGitHubSync(userId);

    expect(progress.status).toBe("complete");
    expect(admin.savedRows[0]).toMatchObject({
      embedding: null,
      indexing_status: "keyword_only",
      indexing_error: "Semantic indexing is temporarily unavailable.",
    });
    expect(admin.savedRows[0]?.searchable_text).toContain("acme/repo-1");
    expect(JSON.stringify(admin.savedRows[0])).not.toContain("secret Gemini");
  });

  it("skips one malformed repository without abandoning the page", async () => {
    queuePages({
      repositories: [
        star(1),
        { ...star(2), repo: { ...star(2).repo, html_url: "not-a-url" } },
      ],
      nextPage: null,
    });

    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "complete",
      discoveredCount: 2,
      savedCount: 1,
      skippedCount: 1,
    });
    expect(admin.savedRows).toHaveLength(1);
  });

  it("records a safe failure and classifies GitHub rate limiting", async () => {
    mocks.listStarredRepositoriesPage.mockRejectedValue(
      new GitHubApiError("rate_limited"),
    );

    await expect(startGitHubSync(userId)).rejects.toMatchObject({
      name: "GitHubSyncError",
      kind: "rate_limited",
      message: "GitHub is rate limited. Try again later.",
    });
    expect(admin.connections.get(userId)).toMatchObject({
      user_id: userId,
      sync_status: "failed",
      active_sync_id: null,
      last_sync_error: "GitHub is rate limited. Try again later.",
    });
  });

  it("marks unauthorized GitHub credentials for reconnection", async () => {
    mocks.listStarredRepositoriesPage.mockRejectedValue(
      new GitHubApiError("unauthorized"),
    );

    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "reconnect_required",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });
    expect(admin.connections.get(userId)).toMatchObject({
      user_id: userId,
      connection_status: "reconnect_required",
      sync_status: "failed",
      active_sync_id: null,
      last_sync_error: "GitHub access expired. Reconnect to resume syncing.",
    });
  });

  it("does not report progress when another sync wins the active-ID guard", async () => {
    const winnerSyncId = "03e7df6c-18cb-4b1c-a5cc-b786c6520a47";
    admin.beforeItemPersistence = () => {
      admin.beforeItemPersistence = null;
      Object.assign(admin.connections.get(userId)!, {
        active_sync_id: winnerSyncId,
        sync_started_at: new Date().toISOString(),
      });
    };
    queuePages({ repositories: [star(1)], nextPage: null });

    await expect(startGitHubSync(userId)).rejects.toBeInstanceOf(
      GitHubSyncError,
    );
    expect(admin.savedRows).toHaveLength(0);
    await expect(startGitHubSync(userId)).resolves.toMatchObject({
      status: "running",
      syncId: winnerSyncId,
    });
  });

  it("lets only one concurrent continuation own and apply the expected page", async () => {
    const activeSyncId = "31906d3b-cb9a-4be4-925f-34e0e815ad59";
    admin.connections.set(
      userId,
      connected({
        sync_status: "running",
        active_sync_id: activeSyncId,
        sync_started_at: new Date().toISOString(),
      }),
    );
    queuePages({ repositories: [star(1)], nextPage: null });

    const results = await Promise.allSettled([
      continueGitHubSync(userId, activeSyncId),
      continueGitHubSync(userId, activeSyncId),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(mocks.listStarredRepositoriesPage).toHaveBeenCalledTimes(1);
    expect(admin.savedRows).toHaveLength(1);
    expect(admin.connections.get(userId)).toMatchObject({
      discovered_count: 1,
      saved_count: 1,
      skipped_count: 0,
    });
  });

  it("preserves a concurrent user edit and defers its provider refresh", async () => {
    queuePages(
      { repositories: [star(1)], nextPage: null },
      {
        repositories: [
          {
            ...star(1),
            repo: { ...star(1).repo, description: "provider refresh" },
          },
        ],
        nextPage: null,
      },
    );
    await startGitHubSync(userId);
    const row = admin.savedRows[0]!;
    row.notes = "note before sync";
    row.content = "content before sync";
    row.tags = ["personal", "search", "TypeScript"];
    row.searchable_text = buildSearchableText(row);
    row.updated_at = "2026-08-15T12:00:00.000Z";

    admin.beforeItemPersistence = () => {
      admin.beforeItemPersistence = null;
      Object.assign(row, {
        notes: "concurrent note",
        content: "concurrent content",
        tags: ["concurrent-user-tag"],
        embedding: [7, 7],
        indexing_status: "ready",
        searchable_text: buildSearchableText({
          ...row,
          notes: "concurrent note",
          content: "concurrent content",
          tags: ["concurrent-user-tag"],
        }),
        updated_at: "2026-08-15T12:01:00.000Z",
      });
    };

    await startGitHubSync(userId);

    expect(admin.savedRows[0]).toMatchObject({
      notes: "concurrent note",
      content: "concurrent content",
      tags: ["concurrent-user-tag"],
      description: "Repository 1",
      embedding: [7, 7],
      updated_at: "2026-08-15T12:01:00.000Z",
    });
  });

  it("rolls back item persistence with failed progress and retries without undercounting", async () => {
    admin.failPageApply = true;
    queuePages({ repositories: [star(1)], nextPage: null });

    await expect(startGitHubSync(userId)).rejects.toThrow(
      "atomic page apply failed",
    );
    expect(admin.savedRows).toHaveLength(0);
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "failed",
      active_sync_id: null,
      discovered_count: 0,
      saved_count: 0,
      skipped_count: 0,
    });

    admin.failPageApply = false;
    queuePages({ repositories: [star(1)], nextPage: null });
    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "complete",
      discoveredCount: 1,
      savedCount: 1,
      skippedCount: 0,
    });
    expect(admin.savedRows).toHaveLength(1);
  });

  it("releases its page lease into a safe failed state after an unexpected error", async () => {
    mocks.getValidGitHubAccessToken.mockRejectedValue(
      new Error("secret token-store failure"),
    );

    await expect(startGitHubSync(userId)).rejects.toThrow(
      "secret token-store failure",
    );
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "failed",
      active_sync_id: null,
      page_lease_id: null,
      page_lease_started_at: null,
      last_sync_error: "GitHub sync failed. Try again later.",
    });
  });

  it("cleans up a newly started sync when its connection read fails before claiming", async () => {
    admin.failConnectionSelectOnce = true;

    await expect(startGitHubSync(userId)).rejects.toThrow(
      "connection read failed",
    );
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "failed",
      active_sync_id: null,
      page_lease_id: null,
      last_sync_error: "GitHub sync failed. Try again later.",
    });
  });

  it("cleans up a sync when begin commits but its response fails", async () => {
    admin.failBeginAfterCommit = true;

    await expect(startGitHubSync(userId)).rejects.toThrow(
      "begin response failed",
    );
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "failed",
      active_sync_id: null,
      page_lease_id: null,
      last_sync_error: "GitHub sync failed. Try again later.",
    });
  });

  it("does not fail a sync when a late duplicate claim sees the next page", async () => {
    const activeSyncId = "6d5eaeeb-908c-49b7-92fd-b5cb9e0c8332";
    admin.connections.set(
      userId,
      connected({
        sync_status: "running",
        active_sync_id: activeSyncId,
        sync_started_at: new Date().toISOString(),
      }),
    );
    admin.beforePageClaim = () => {
      admin.beforePageClaim = null;
      Object.assign(admin.connections.get(userId)!, {
        next_page: 2,
        discovered_count: 100,
        saved_count: 100,
        page_lease_id: null,
        page_lease_started_at: null,
        sync_started_at: new Date().toISOString(),
      });
    };

    await expect(
      continueGitHubSync(userId, activeSyncId),
    ).rejects.toMatchObject({
      name: "GitHubSyncError",
      kind: "conflict",
    });
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "running",
      active_sync_id: activeSyncId,
      next_page: 2,
      discovered_count: 100,
      saved_count: 100,
      last_sync_error: null,
    });
  });

  it("loads existing rows in URL chunks no larger than twenty-five", async () => {
    queuePages({
      repositories: Array.from({ length: 100 }, (_, index) => star(index + 1)),
      nextPage: null,
    });

    await startGitHubSync(userId);

    const urlFilters = admin.calls
      .flatMap((call) => call.filters)
      .filter(
        (
          filter,
        ): filter is Extract<QueryCall["filters"][number], { kind: "in" }> =>
          filter.kind === "in" && filter.column === "normalized_url",
      );
    expect(urlFilters).toHaveLength(4);
    expect(Math.max(...urlFilters.map((filter) => filter.values.length))).toBe(
      25,
    );
  });

  it("renews the sync heartbeat while advancing a claimed page", async () => {
    const activeSyncId = "eceaeb20-13b5-464f-8dbc-ff8280e36547";
    const originalHeartbeat = new Date(
      Date.now() - 5 * 60 * 1_000,
    ).toISOString();
    admin.connections.set(
      userId,
      connected({
        sync_status: "running",
        active_sync_id: activeSyncId,
        sync_started_at: originalHeartbeat,
      }),
    );
    queuePages({
      repositories: Array.from({ length: 100 }, (_, index) => star(index + 1)),
      nextPage: 2,
    });

    await continueGitHubSync(userId, activeSyncId);

    expect(
      Date.parse(admin.connections.get(userId)!.sync_started_at!),
    ).toBeGreaterThan(Date.parse(originalHeartbeat));
    expect(admin.connections.get(userId)).toMatchObject({
      sync_status: "running",
      active_sync_id: activeSyncId,
      next_page: 2,
      page_lease_id: null,
      page_lease_started_at: null,
    });
  });

  it("rejects a continuation whose sync ID is not active", async () => {
    await expect(
      continueGitHubSync(userId, "46bb5246-0a3a-49ba-88ce-8ce5e38946db"),
    ).rejects.toMatchObject({
      name: "GitHubSyncError",
      kind: "conflict",
    });
    expect(mocks.getValidGitHubAccessToken).not.toHaveBeenCalled();
    expect(mocks.listStarredRepositoriesPage).not.toHaveBeenCalled();
  });

  it("returns safe terminal states for missing and disconnected accounts", async () => {
    admin.connections.delete(userId);
    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "not_connected",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });

    admin.connections.set(
      userId,
      connected({ connection_status: "reconnect_required" }),
    );
    await expect(startGitHubSync(userId)).resolves.toEqual({
      status: "reconnect_required",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });
  });
});
