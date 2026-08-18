import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  requireUser: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  getAuthenticatedAccount: vi.fn(),
  saveXConnection: vi.fn(),
  getXConnection: vi.fn(),
  disconnectX: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));

vi.mock("@/lib/x/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/x/api")>();
  return {
    ...original,
    exchangeOAuthCode: mocks.exchangeOAuthCode,
    getAuthenticatedAccount: mocks.getAuthenticatedAccount,
  };
});

vi.mock("@/lib/x/connections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/x/connections")>();
  return {
    ...original,
    saveXConnection: mocks.saveXConnection,
    getXConnection: mocks.getXConnection,
    disconnectX: mocks.disconnectX,
  };
});

import { GET as callbackGet } from "@/app/api/x/callback/route";
import { GET as connectGet } from "@/app/api/x/connect/route";
import {
  DELETE as connectionDelete,
  GET as connectionGet,
} from "@/app/api/x/connection/route";

const USER_ID = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";
const STATE_COOKIE = "savesort_x_state";
const PKCE_COOKIE = "savesort_x_pkce";
const VERIFIER = "a".repeat(43);

const account = {
  id: "42",
  username: "someone",
  name: "Some One",
  profileImageUrl: null,
};

function request(url: string): NextRequest {
  return new NextRequest(url);
}

function responseCookies(response: Response) {
  return (
    response as Response & {
      cookies: {
        get(name: string): { maxAge?: number; value: string } | undefined;
      };
    }
  ).cookies;
}

function setAttemptCookies(state?: string, verifier?: string) {
  mocks.cookies.mockResolvedValue({
    get: (name: string) => {
      if (name === STATE_COOKIE && state) return { value: state };
      if (name === PKCE_COOKIE && verifier) return { value: verifier };
      return undefined;
    },
  });
}

describe("X OAuth routes", () => {
  beforeEach(() => {
    vi.stubEnv("X_CLIENT_ID", "x-client-id");
    vi.stubEnv("X_CLIENT_SECRET", "x-client-secret");
    vi.stubEnv(
      "X_TOKEN_ENCRYPTION_KEY",
      Buffer.alloc(32, 3).toString("base64"),
    );
    mocks.requireUser.mockResolvedValue({ user: { id: USER_ID } });
    setAttemptCookies();
    mocks.exchangeOAuthCode.mockResolvedValue({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 7200,
      scope: "tweet.read users.read bookmark.read offline.access",
      token_type: "bearer",
    });
    mocks.getAuthenticatedAccount.mockResolvedValue(account);
    mocks.saveXConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("redirects to X with PKCE S256 and read-only scopes", async () => {
      const response = await connectGet(
        request("https://app.test/api/x/connect"),
      );

      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(
        "https://x.com/i/oauth2/authorize",
      );
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://app.test/api/x/callback",
      );

      const scopes = location.searchParams.get("scope")?.split(" ") ?? [];
      expect(scopes).toContain("bookmark.read");
      expect(scopes).toContain("offline.access");
      // Read-only: no write scope may ever be requested.
      expect(scopes.some((scope) => scope.endsWith(".write"))).toBe(false);
    });

    it("stores state and verifier in HttpOnly cookies, never in the URL", async () => {
      const response = await connectGet(
        request("https://app.test/api/x/connect"),
      );

      const location = new URL(response.headers.get("location") ?? "");
      const state = location.searchParams.get("state");
      const challenge = location.searchParams.get("code_challenge");
      const cookies = responseCookies(response);

      expect(cookies.get(STATE_COOKIE)?.value).toBe(state);
      const verifier = cookies.get(PKCE_COOKIE)!.value;
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      // The verifier itself must never appear in the redirect.
      expect(location.search).not.toContain(verifier);
      // The challenge must be S256(verifier).
      expect(challenge).toBe(
        createHash("sha256").update(verifier).digest("base64url"),
      );
    });

    it("requires an authenticated GRAPPlin user", async () => {
      mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

      const response = await connectGet(
        request("https://app.test/api/x/connect"),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("callback", () => {
    function callbackRequest(state: string) {
      return request(
        `https://app.test/api/x/callback?code=the-code&state=${state}`,
      );
    }

    it("saves the connection when state and verifier match", async () => {
      setAttemptCookies("abc", VERIFIER);

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?xConnected=1",
      );
      expect(mocks.exchangeOAuthCode).toHaveBeenCalledWith(
        "the-code",
        VERIFIER,
        "https://app.test/api/x/callback",
      );
      // Identity comes from the token, never from the request.
      expect(mocks.saveXConnection).toHaveBeenCalledWith(
        USER_ID,
        account,
        expect.objectContaining({ refresh_token: "refresh" }),
      );
    });

    it("rejects a mismatched state without exchanging the code", async () => {
      setAttemptCookies("abc", VERIFIER);

      const response = await callbackGet(callbackRequest("different"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("rejects a callback with no stored attempt", async () => {
      setAttemptCookies();

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("rejects a callback missing the PKCE verifier", async () => {
      setAttemptCookies("abc", undefined);

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("rejects a cancelled authorization that returns no code", async () => {
      setAttemptCookies("abc", VERIFIER);

      const response = await callbackGet(
        request(
          "https://app.test/api/x/callback?state=abc&error=access_denied",
        ),
      );

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("cannot bind an X account to a signed-out session", async () => {
      // Defends against a callback being replayed in another browser.
      mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));
      setAttemptCookies("abc", VERIFIER);

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.saveXConnection).not.toHaveBeenCalled();
    });

    it("always clears the attempt cookies so a code cannot be replayed", async () => {
      setAttemptCookies("abc", VERIFIER);

      const response = await callbackGet(callbackRequest("abc"));
      const cookies = responseCookies(response);

      expect(cookies.get(STATE_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
      expect(cookies.get(PKCE_COOKIE)).toMatchObject({ value: "", maxAge: 0 });
    });

    it("rejects a grant with no refresh token", async () => {
      // Without offline.access the connection would silently die in hours.
      setAttemptCookies("abc", VERIFIER);
      mocks.exchangeOAuthCode.mockResolvedValue({
        access_token: "access",
        expires_in: 7200,
        scope: "tweet.read",
        token_type: "bearer",
      });

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.saveXConnection).not.toHaveBeenCalled();
    });

    it("does not save a connection when the exchange fails", async () => {
      setAttemptCookies("abc", VERIFIER);
      mocks.exchangeOAuthCode.mockRejectedValue(new Error("denied"));

      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toContain("xError=");
      expect(mocks.saveXConnection).not.toHaveBeenCalled();
    });
  });

  describe("connection", () => {
    it("returns only the signed-in user's connection", async () => {
      mocks.getXConnection.mockResolvedValue({
        connected: true,
        username: "someone",
      });

      const response = await connectionGet();

      expect(await response.json()).toEqual({
        connection: { connected: true, username: "someone" },
      });
      expect(mocks.getXConnection).toHaveBeenCalledWith(USER_ID);
    });

    it("disconnects only the signed-in user", async () => {
      mocks.disconnectX.mockResolvedValue(undefined);

      const response = await connectionDelete();

      expect(await response.json()).toEqual({ disconnected: true });
      expect(mocks.disconnectX).toHaveBeenCalledWith(USER_ID);
    });

    it("requires authentication to disconnect", async () => {
      mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

      const response = await connectionDelete();

      expect(response.status).toBe(401);
      expect(mocks.disconnectX).not.toHaveBeenCalled();
    });
  });
});
