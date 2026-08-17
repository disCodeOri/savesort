import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  refreshOAuthToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

vi.mock("@/lib/reddit/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reddit/api")>();
  return { ...original, refreshOAuthToken: mocks.refreshOAuthToken };
});

import { RedditApiError } from "@/lib/reddit/api";
import {
  getValidRedditAccessToken,
  isPermanentGrant,
  saveRedditConnection,
} from "@/lib/reddit/connections";
import { decryptSecret, encryptSecret } from "@/lib/reddit/crypto";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const encryptionKey = Buffer.alloc(32, 5).toString("base64");

interface SecretRow {
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: string | null;
}

class AdminClientMock {
  secret: SecretRow | null = null;
  connectionUpdates: Record<string, unknown>[] = [];
  readonly rpcCalls: Array<{ name: string; values: Record<string, unknown> }> =
    [];
  /** Simulates another request winning the update race. */
  rejectSecretUpdate = false;

  from(table: string) {
    const updates: Record<string, unknown>[] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        if (table === "reddit_connections") this.connectionUpdates.push(values);
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
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve),
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
  process.env.REDDIT_TOKEN_ENCRYPTION_KEY = encryptionKey;
  admin = new AdminClientMock();
  mocks.createAdminClient.mockReset().mockReturnValue(admin);
  mocks.refreshOAuthToken.mockReset();
});

afterEach(() => {
  delete process.env.REDDIT_TOKEN_ENCRYPTION_KEY;
});

describe("isPermanentGrant", () => {
  it("only accepts a grant that came back with a refresh token", () => {
    const base = { access_token: "a", expires_in: 3600, scope: "identity" };

    expect(isPermanentGrant({ ...base, refresh_token: "r" })).toBe(true);
    expect(isPermanentGrant(base)).toBe(false);
    expect(isPermanentGrant({ ...base, refresh_token: "" })).toBe(false);
  });
});

describe("saveRedditConnection", () => {
  it("encrypts both tokens before they reach the database", async () => {
    await saveRedditConnection(
      USER_ID,
      { id: "2fp8x", name: "savesort_user", icon_img: null },
      {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "identity history",
      },
    );

    const call = admin.rpcCalls[0]!;
    expect(call.name).toBe("save_reddit_connection");
    expect(call.values.p_reddit_username).toBe("savesort_user");
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

describe("getValidRedditAccessToken", () => {
  it("reuses a token that has not reached its refresh window", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("still-good"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
    };

    await expect(getValidRedditAccessToken(USER_ID)).resolves.toBe(
      "still-good",
    );
    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("keeps the durable refresh token when a refresh omits one", async () => {
    const storedRefresh = encryptSecret("durable-refresh");
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: storedRefresh,
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "fresh",
      expires_in: 3600,
      scope: "identity history",
    });

    await expect(getValidRedditAccessToken(USER_ID)).resolves.toBe("fresh");
    expect(mocks.refreshOAuthToken).toHaveBeenCalledWith("durable-refresh");
    expect(decryptSecret(admin.secret!.refresh_token_ciphertext!)).toBe(
      "durable-refresh",
    );
  });

  it("stores a rotated refresh token when Reddit sends one", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("old-refresh"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "fresh",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: "identity history",
    });

    await getValidRedditAccessToken(USER_ID);

    expect(decryptSecret(admin.secret!.refresh_token_ciphertext!)).toBe(
      "new-refresh",
    );
  });

  it("requires a reconnect when the refresh token was revoked", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("revoked"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockRejectedValue(
      new RedditApiError("unauthorized"),
    );

    await expect(getValidRedditAccessToken(USER_ID)).rejects.toThrow(
      "Reddit needs to be reconnected.",
    );
    expect(admin.connectionUpdates).toContainEqual({
      connection_status: "reconnect_required",
    });
  });

  it("requires a reconnect when no refresh token was ever stored", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: null,
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };

    await expect(getValidRedditAccessToken(USER_ID)).rejects.toThrow(
      "Reddit needs to be reconnected.",
    );
    expect(mocks.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("requires a reconnect when there is no stored secret at all", async () => {
    admin.secret = null;

    await expect(getValidRedditAccessToken(USER_ID)).rejects.toThrow(
      "Reddit needs to be reconnected.",
    );
  });

  it("adopts the winning token when another request refreshed first", async () => {
    admin.secret = {
      access_token_ciphertext: encryptSecret("expired"),
      refresh_token_ciphertext: encryptSecret("refresh"),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    mocks.refreshOAuthToken.mockResolvedValue({
      access_token: "ours",
      expires_in: 3600,
      scope: "identity history",
    });
    admin.rejectSecretUpdate = true;
    const winner = {
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

    await expect(getValidRedditAccessToken(USER_ID)).resolves.toBe("theirs");
  });
});
