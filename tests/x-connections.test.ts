import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  refreshOAuthToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/x/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/x/api")>();
  return {
    ...original,
    refreshOAuthToken: mocks.refreshOAuthToken,
    revokeToken: mocks.revokeToken,
  };
});

import { XApiError } from "@/lib/x/api";
import {
  disconnectX,
  getValidXAccessToken,
  hasRefreshToken,
  saveXConnection,
} from "@/lib/x/connections";
import { decryptSecret, encryptSecret } from "@/lib/x/crypto";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

interface SecretRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
}

class AdminClientMock {
  secret: SecretRow | null = null;
  connectionUpdates: Record<string, unknown>[] = [];
  readonly deletedTables: string[] = [];
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];
  /** Simulates another request winning the refresh race. */
  rejectSecretUpdate = false;

  from(table: string) {
    const updates: Record<string, unknown>[] = [];
    let isDelete = false;
    const builder = {
      select: () => builder,
      eq: () => builder,
      delete: () => {
        isDelete = true;
        this.deletedTables.push(table);
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        if (table === "x_connections") this.connectionUpdates.push(values);
        return builder;
      },
      maybeSingle: () => {
        if (updates.length === 0) {
          return Promise.resolve({ data: this.secret, error: null });
        }
        if (this.rejectSecretUpdate) {
          return Promise.resolve({ data: null, error: null });
        }
        this.secret = { ...this.secret!, ...updates[0] } as SecretRow;
        return Promise.resolve({ data: this.secret, error: null });
      },
      then: (resolve: (result: unknown) => unknown) => {
        void isDelete;
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return builder;
  }

  rpc(name: string, values: Record<string, unknown>) {
    this.rpcCalls.push({ name, values });
    return Promise.resolve({ data: null, error: null });
  }
}

let admin: AdminClientMock;

beforeEach(() => {
  process.env.X_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.refreshOAuthToken.mockReset();
  mocks.revokeToken.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.X_TOKEN_ENCRYPTION_KEY;
});

describe("hasRefreshToken", () => {
  it("only accepts a grant that carries a refresh token", () => {
    const base = {
      access_token: "a",
      expires_in: 7200,
      scope: "s",
      token_type: "bearer",
    };
    expect(hasRefreshToken({ ...base, refresh_token: "r" })).toBe(true);
    expect(hasRefreshToken(base)).toBe(false);
    expect(hasRefreshToken({ ...base, refresh_token: "" })).toBe(false);
  });
});

describe("saveXConnection", () => {
  it("encrypts both tokens before they reach the database", async () => {
    await saveXConnection(
      USER_ID,
      {
        id: "42",
        username: "someone",
        name: "Some One",
        profileImageUrl: null,
      },
      {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 7200,
        scope: "tweet.read offline.access",
        token_type: "bearer",
      },
    );

    const call = admin.rpcCalls[0]!;
    expect(call.name).toBe("save_x_connection");
    // Plaintext must never appear in the stored payload.
    expect(JSON.stringify(call.values)).not.toContain("access-token");
    expect(JSON.stringify(call.values)).not.toContain("refresh-token");
    expect(decryptSecret(String(call.values.p_access_token_ciphertext))).toBe(
      "access-token",
    );
    expect(decryptSecret(String(call.values.p_refresh_token_ciphertext))).toBe(
      "refresh-token",
    );
  });
});

describe("getValidXAccessToken", () => {
  it("reuses a token that is still comfortably valid", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("still-good"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
    };

    await expect(getValidXAccessToken(USER_ID)).resolves.toBe("still-good");
    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("refreshes shortly before expiry rather than after failing", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expiring"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() + 10_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "fresh",
      refresh_token: "rotated",
      expires_in: 7200,
      scope: "s",
      token_type: "bearer",
    });

    await expect(getValidXAccessToken(USER_ID)).resolves.toBe("fresh");
  });

  it("stores the rotated refresh token X returns", async () => {
    // X rotates refresh tokens; keeping the old one would break the next refresh.
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("old-refresh"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "fresh",
      refresh_token: "new-refresh",
      expires_in: 7200,
      scope: "s",
      token_type: "bearer",
    });

    await getValidXAccessToken(USER_ID);

    expect(decryptSecret(admin.secret!.refresh_token_ciphertext!)).toBe(
      "new-refresh",
    );
  });

  it("keeps the stored refresh token when the response omits one", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("durable"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "fresh",
      expires_in: 7200,
      scope: "s",
      token_type: "bearer",
    });

    await getValidXAccessToken(USER_ID);

    expect(decryptSecret(admin.secret!.refresh_token_ciphertext!)).toBe(
      "durable",
    );
  });

  it("marks reconnect_required when the refresh token was revoked", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("revoked"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockRejectedValue(new XApiError("unauthorized"));

    await expect(getValidXAccessToken(USER_ID)).rejects.toThrow(
      "X needs to be reconnected.",
    );
    expect(admin.connectionUpdates).toContainEqual({
      connection_status: "reconnect_required",
    });
  });

  it("does not retry forever when refreshing fails transiently", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockRejectedValue(new XApiError("provider_error"));

    await expect(getValidXAccessToken(USER_ID)).rejects.toBeInstanceOf(
      XApiError,
    );
    // Exactly one refresh attempt; no loop.
    expect(mocks.refreshOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("adopts the winning token when another request refreshed first", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ours",
      expires_in: 7200,
      scope: "s",
      token_type: "bearer",
    });
    admin.rejectSecretUpdate = true;

    const winner: SecretRow = {
      access_token_ciphertext: encryptSecret("theirs"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    const originalFrom = admin.from.bind(admin);
    let updateAttempted = false;
    vi.spyOn(admin, "from").mockImplementation((table: string) => {
      if (updateAttempted) admin.secret = winner;
      updateAttempted = true;
      return originalFrom(table);
    });

    await expect(getValidXAccessToken(USER_ID)).resolves.toBe("theirs");
  });

  it("requires a reconnect when no credentials are stored", async () => {
    admin.secret = null;

    await expect(getValidXAccessToken(USER_ID)).rejects.toThrow(
      "X needs to be reconnected.",
    );
  });
});

describe("disconnectX", () => {
  it("revokes at X and removes only the credentials", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("access"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
    };

    await disconnectX(USER_ID);

    expect(mocks.revokeToken).toHaveBeenCalledWith("access");
    expect(admin.deletedTables).toEqual([
      "x_connection_secrets",
      "x_connections",
    ]);
    // saved_items is never deleted: the user's library outlives the provider.
    expect(admin.deletedTables).not.toContain("saved_items");
  });

  it("still disconnects locally when revocation fails", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("access"),
      refresh_token_ciphertext: null,
      access_token_expires_at: null,
    };
    mocks.revokeToken.mockRejectedValue(new Error("network down"));

    await expect(disconnectX(USER_ID)).resolves.toBeUndefined();
    expect(admin.deletedTables).toContain("x_connection_secrets");
  });
});
