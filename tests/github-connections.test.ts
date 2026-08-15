import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace("encrypted:", "")),
  refreshOAuthToken: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/github/crypto", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));

vi.mock("@/lib/github/api", () => ({
  GitHubApiError: class GitHubApiError extends Error {
    constructor(public readonly kind: string) {
      super("GitHub provider error");
    }
  },
  refreshOAuthToken: mocks.refreshOAuthToken,
}));

import {
  disconnectGitHub,
  getGitHubConnection,
  getValidGitHubAccessToken,
  saveGitHubConnection,
} from "@/lib/github/connections";
import { GitHubApiError } from "@/lib/github/api";

type DatabaseResponse = { data: unknown; error: { message: string } | null };

interface QueryCall {
  table: string;
  operation: "delete" | "select" | "update" | "upsert";
  columns?: string;
  values?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

class QueryMock implements PromiseLike<DatabaseResponse> {
  private readonly call: QueryCall;

  constructor(
    private readonly client: AdminClientMock,
    table: string,
  ) {
    this.call = { table, operation: "select", filters: [] };
  }

  delete() {
    this.call.operation = "delete";
    this.client.calls.push(this.call);
    return this;
  }

  eq(column: string, value: unknown) {
    this.call.filters.push([column, value]);
    return this;
  }

  maybeSingle() {
    const failure = this.client.failureFor(this.call);
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.client.responseFor(this.call));
  }

  select(columns: string) {
    this.call.columns = columns;
    if (this.call.operation === "select") {
      this.client.calls.push(this.call);
    }
    return this;
  }

  then<TResult1 = DatabaseResponse, TResult2 = never>(
    onfulfilled?:
      ((value: DatabaseResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const failure = this.client.failureFor(this.call);
    if (failure) return Promise.reject(failure).then(onfulfilled, onrejected);
    return Promise.resolve(this.client.responseFor(this.call)).then(
      onfulfilled,
      onrejected,
    );
  }

  update(values: Record<string, unknown>) {
    this.call.operation = "update";
    this.call.values = values;
    this.client.calls.push(this.call);
    return this;
  }

  upsert(values: Record<string, unknown>) {
    this.call.operation = "upsert";
    this.call.values = values;
    this.client.calls.push(this.call);
    return this;
  }
}

class AdminClientMock {
  calls: QueryCall[] = [];
  failures = new Map<string, Error>();
  responses = new Map<string, DatabaseResponse | DatabaseResponse[]>();

  from(table: string) {
    return new QueryMock(this, table);
  }

  responseFor(call: QueryCall): DatabaseResponse {
    const response = this.responses.get(`${call.table}:${call.operation}`);
    if (Array.isArray(response)) {
      return response.shift() ?? { data: null, error: null };
    }
    return response ?? { data: null, error: null };
  }

  failureFor(call: QueryCall): Error | undefined {
    return this.failures.get(`${call.table}:${call.operation}`);
  }
}

const userId = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";

function expiredSecret(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    access_token_ciphertext: "encrypted:ghu_old",
    refresh_token_ciphertext: "encrypted:ghr_old",
    access_token_expires_at: new Date(Date.now() + 1_000).toISOString(),
    refresh_token_expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    ...overrides,
  };
}

function lastCall(client: AdminClientMock, operation: QueryCall["operation"]) {
  return client.calls.filter((call) => call.operation === operation).at(-1);
}

describe("GitHub connections", () => {
  let admin: AdminClientMock;

  beforeEach(() => {
    admin = new AdminClientMock();
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.refreshOAuthToken.mockReset();
    mocks.encryptSecret.mockClear();
    mocks.decryptSecret.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves encrypted credentials with absolute expiration timestamps", async () => {
    const beforeSave = Date.now();

    await saveGitHubConnection(
      userId,
      {
        id: 1,
        login: "octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      {
        access_token: "ghu_access",
        refresh_token: "ghr_refresh",
        expires_in: 3_600,
        refresh_token_expires_in: 7_200,
      },
    );

    const connection = admin.calls.find(
      (call) =>
        call.operation === "upsert" && call.table === "github_connections",
    );
    const secret = admin.calls.find(
      (call) =>
        call.operation === "upsert" &&
        call.table === "github_connection_secrets",
    );

    expect(connection?.values).toMatchObject({
      user_id: userId,
      github_user_id: 1,
      github_login: "octocat",
      connection_status: "connected",
      sync_status: "idle",
    });
    expect(secret?.values).toMatchObject({
      user_id: userId,
      access_token_ciphertext: "encrypted:ghu_access",
      refresh_token_ciphertext: "encrypted:ghr_refresh",
    });
    expect(secret?.values?.access_token_expires_at).toEqual(expect.any(String));
    expect(
      Date.parse(secret?.values?.access_token_expires_at as string),
    ).toBeGreaterThanOrEqual(beforeSave + 3_599_000);
    expect(mocks.encryptSecret).toHaveBeenCalledWith("ghu_access");
    expect(mocks.encryptSecret).toHaveBeenCalledWith("ghr_refresh");
    expect(
      admin.calls.every((call) =>
        call.filters.some(
          ([column, value]) => column === "user_id" && value === userId,
        ),
      ),
    ).toBe(true);
  });

  it("stages credentials before publishing connection metadata", async () => {
    await saveGitHubConnection(
      userId,
      { id: 1, login: "octocat", avatar_url: "https://avatar.test" },
      {
        access_token: "ghu_access",
        refresh_token: "ghr_refresh",
        expires_in: 3_600,
        refresh_token_expires_in: 7_200,
      },
    );

    expect(
      admin.calls
        .filter((call) => call.operation === "upsert")
        .map((call) => call.table),
    ).toEqual(["github_connection_secrets", "github_connections"]);
  });

  it("removes staged credentials when connection metadata cannot be saved", async () => {
    admin.responses.set("github_connections:upsert", {
      data: null,
      error: { message: "metadata write failed" },
    });

    await expect(
      saveGitHubConnection(
        userId,
        { id: 1, login: "octocat", avatar_url: "https://avatar.test" },
        { access_token: "ghu_access", expires_in: 3_600 },
      ),
    ).rejects.toThrow("GitHub connection could not be saved.");

    expect(
      admin.calls.map((call) => `${call.operation}:${call.table}`),
    ).toEqual([
      "upsert:github_connection_secrets",
      "upsert:github_connections",
      "delete:github_connection_secrets",
    ]);
  });

  it("returns a public connection status without credential fields", async () => {
    admin.responses.set("github_connections:select", {
      data: {
        github_login: "octocat",
        github_avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        connection_status: "connected",
        sync_status: "idle",
        last_synced_at: null,
        discovered_count: 0,
        saved_count: 0,
        skipped_count: 0,
        last_sync_error: null,
      },
      error: null,
    });

    const publicStatus = await getGitHubConnection(userId);

    expect(publicStatus).toEqual({
      connected: true,
      githubLogin: "octocat",
      githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      connectionStatus: "connected",
      syncStatus: "idle",
      lastSyncedAt: null,
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
      lastSyncError: null,
    });
    expect(JSON.stringify(publicStatus)).not.toMatch(/token|ciphertext/i);
    expect(lastCall(admin, "select")?.columns).toBe(
      "github_login, github_avatar_url, connection_status, sync_status, last_synced_at, discovered_count, saved_count, skipped_count, last_sync_error",
    );
  });

  it("refreshes access tokens expiring within sixty seconds", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret({
        access_token_expires_at: new Date(Date.now() + 59_000).toISOString(),
      }),
      error: null,
    });
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      refresh_token: "ghr_new",
      expires_in: 3_600,
      refresh_token_expires_in: 7_200,
    });
    admin.responses.set("github_connection_secrets:update", {
      data: {
        access_token_ciphertext: "encrypted:ghu_new",
        access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      error: null,
    });

    await expect(getValidGitHubAccessToken(userId)).resolves.toBe("ghu_new");

    expect(mocks.refreshOAuthToken).toHaveBeenCalledWith("ghr_old");
    expect(lastCall(admin, "update")?.values).toMatchObject({
      access_token_ciphertext: "encrypted:ghu_new",
      refresh_token_ciphertext: "encrypted:ghr_new",
    });
    expect(lastCall(admin, "update")?.filters).toContainEqual([
      "user_id",
      userId,
    ]);
    expect(lastCall(admin, "update")?.filters).toContainEqual([
      "access_token_ciphertext",
      "encrypted:ghu_old",
    ]);
  });

  it("deletes credentials before the connection metadata", async () => {
    await disconnectGitHub(userId);

    expect(
      admin.calls
        .filter((call) => call.operation === "delete")
        .map((call) => call.table),
    ).toEqual(["github_connection_secrets", "github_connections"]);
  });

  it("maps database save failures to a safe error", async () => {
    admin.responses.set("github_connections:upsert", {
      data: null,
      error: { message: "relation github_connection_secrets does not exist" },
    });

    await expect(
      saveGitHubConnection(
        userId,
        { id: 1, login: "octocat", avatar_url: "https://avatar.test" },
        { access_token: "ghu_access", expires_in: 3_600 },
      ),
    ).rejects.toThrow("GitHub connection could not be saved.");
  });

  it("marks the connection for reconnection when refresh is unauthorized", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret(),
      error: null,
    });
    mocks.refreshOAuthToken.mockRejectedValue(
      new GitHubApiError("unauthorized"),
    );

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );

    expect(lastCall(admin, "update")?.values).toEqual({
      connection_status: "reconnect_required",
    });
  });

  it("maps a rejected rotated-credential write to a safe error", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret(),
      error: null,
    });
    admin.failures.set(
      "github_connection_secrets:update",
      new Error("socket closed while writing credentials"),
    );
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      refresh_token: "ghr_new",
      expires_in: 3_600,
      refresh_token_expires_in: 7_200,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub connection could not be saved.",
    );
  });

  it("marks reconnect required for an expired stored refresh token", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret({
        refresh_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
      error: null,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );

    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
    expect(lastCall(admin, "update")?.values).toEqual({
      connection_status: "reconnect_required",
    });
  });

  it("marks reconnect required when the stored refresh token is missing", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret({ refresh_token_ciphertext: null }),
      error: null,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );

    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
    expect(lastCall(admin, "update")?.values).toEqual({
      connection_status: "reconnect_required",
    });
  });

  it("marks reconnect required when GitHub omits rotated credentials", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret(),
      error: null,
    });
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      expires_in: 3_600,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );

    expect(
      admin.calls.filter(
        (call) =>
          call.operation === "update" &&
          call.table === "github_connection_secrets",
      ),
    ).toHaveLength(0);
    expect(lastCall(admin, "update")?.values).toEqual({
      connection_status: "reconnect_required",
    });
  });

  it("marks reconnect required when GitHub omits the rotated expiry", async () => {
    admin.responses.set("github_connection_secrets:select", {
      data: expiredSecret(),
      error: null,
    });
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      refresh_token: "ghr_new",
      expires_in: 3_600,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );

    expect(
      admin.calls.filter(
        (call) =>
          call.operation === "update" &&
          call.table === "github_connection_secrets",
      ),
    ).toHaveLength(0);
  });

  it("does not return an unpersisted rotated access token after a zero-row update", async () => {
    admin.responses.set("github_connection_secrets:select", [
      { data: expiredSecret(), error: null },
      { data: null, error: null },
    ]);
    admin.responses.set("github_connection_secrets:update", {
      data: null,
      error: null,
    });
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      refresh_token: "ghr_new",
      expires_in: 3_600,
      refresh_token_expires_in: 7_200,
    });

    await expect(getValidGitHubAccessToken(userId)).rejects.toThrow(
      "GitHub needs to be reconnected.",
    );
  });

  it("uses the persisted winner when another refresh updates credentials first", async () => {
    admin.responses.set("github_connection_secrets:select", [
      { data: expiredSecret(), error: null },
      {
        data: expiredSecret({
          access_token_ciphertext: "encrypted:ghu_winner",
          refresh_token_ciphertext: "encrypted:ghr_winner",
          access_token_expires_at: new Date(
            Date.now() + 3_600_000,
          ).toISOString(),
        }),
        error: null,
      },
    ]);
    admin.responses.set("github_connection_secrets:update", {
      data: null,
      error: null,
    });
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ghu_new",
      refresh_token: "ghr_new",
      expires_in: 3_600,
      refresh_token_expires_in: 7_200,
    });

    await expect(getValidGitHubAccessToken(userId)).resolves.toBe("ghu_winner");
  });
});
