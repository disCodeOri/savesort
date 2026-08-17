import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  disconnectReddit: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  getRedditConnection: vi.fn(),
  getRedditIdentity: vi.fn(),
  requireUser: vi.fn(),
  saveRedditConnection: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

vi.mock("@/lib/auth/require-user", () => ({ requireUser: mocks.requireUser }));

vi.mock("@/lib/reddit/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/reddit/api")>();
  return {
    ...original,
    exchangeOAuthCode: mocks.exchangeOAuthCode,
    getRedditIdentity: mocks.getRedditIdentity,
  };
});

vi.mock("@/lib/reddit/connections", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/reddit/connections")>();
  return {
    ...original,
    disconnectReddit: mocks.disconnectReddit,
    getRedditConnection: mocks.getRedditConnection,
    saveRedditConnection: mocks.saveRedditConnection,
  };
});

import { GET as callbackGet } from "@/app/api/reddit/callback/route";
import { GET as connectGet } from "@/app/api/reddit/connect/route";
import {
  DELETE as connectionDelete,
  GET as connectionGet,
} from "@/app/api/reddit/connection/route";

const userId = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";
const stateCookie = "savesort_reddit_state";
const identity = {
  id: "2fp8x",
  name: "savesort_user",
  icon_img: "https://styles.redditmedia.com/avatar.png",
};

function request(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, {
    ...(cookie ? { headers: { cookie } } : {}),
  });
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

describe("Reddit OAuth routes", () => {
  beforeEach(() => {
    vi.stubEnv("REDDIT_APP_CLIENT_ID", "reddit-client-id");
    vi.stubEnv("REDDIT_APP_CLIENT_SECRET", "reddit-client-secret");
    vi.stubEnv("REDDIT_TOKEN_ENCRYPTION_KEY", "unused");
    vi.stubEnv("REDDIT_USER_AGENT", "web:savesort:v0.1 (by /u/savesort)");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unused");
    mocks.requireUser.mockResolvedValue({ user: { id: userId } });
    mocks.cookies.mockResolvedValue({ get: () => undefined });
    mocks.exchangeOAuthCode.mockResolvedValue({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "identity history",
    });
    mocks.getRedditIdentity.mockResolvedValue(identity);
    mocks.saveRedditConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("connect", () => {
    it("redirects to Reddit asking for a permanent identity and history grant", async () => {
      const response = await connectGet(
        request("https://app.test/api/reddit/connect"),
      );

      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe(
        "https://www.reddit.com/api/v1/authorize",
      );
      expect(location.searchParams.get("client_id")).toBe("reddit-client-id");
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("duration")).toBe("permanent");
      expect(location.searchParams.get("scope")).toBe("identity history");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://app.test/api/reddit/callback",
      );

      const state = location.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(responseCookies(response).get(stateCookie)).toMatchObject({
        value: state,
      });
    });

    it("refuses to start without a signed-in user", async () => {
      mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

      const response = await connectGet(
        request("https://app.test/api/reddit/connect"),
      );

      expect(response.status).toBe(401);
    });
  });

  describe("callback", () => {
    function callbackRequest(state: string, cookieState?: string) {
      mocks.cookies.mockResolvedValue({
        get: (name: string) =>
          name === stateCookie && cookieState
            ? { value: cookieState }
            : undefined,
      });
      return request(
        `https://app.test/api/reddit/callback?code=the-code&state=${state}`,
      );
    }

    it("saves the connection and starts a sync when the state matches", async () => {
      const response = await callbackGet(callbackRequest("abc", "abc"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?redditSync=connect",
      );
      expect(mocks.exchangeOAuthCode).toHaveBeenCalledWith(
        "the-code",
        "https://app.test/api/reddit/callback",
      );
      expect(mocks.saveRedditConnection).toHaveBeenCalledWith(
        userId,
        identity,
        expect.objectContaining({ refresh_token: "refresh" }),
      );
      expect(responseCookies(response).get(stateCookie)).toMatchObject({
        value: "",
        maxAge: 0,
      });
    });

    it("rejects a mismatched state without exchanging the code", async () => {
      const response = await callbackGet(callbackRequest("abc", "different"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?redditError=authorization_failed",
      );
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("rejects a callback with no stored state", async () => {
      const response = await callbackGet(callbackRequest("abc"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?redditError=authorization_failed",
      );
      expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it("rejects a temporary grant that cannot be refreshed later", async () => {
      mocks.exchangeOAuthCode.mockResolvedValue({
        access_token: "access",
        expires_in: 3600,
        scope: "identity history",
      });

      const response = await callbackGet(callbackRequest("abc", "abc"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?redditError=authorization_failed",
      );
      expect(mocks.saveRedditConnection).not.toHaveBeenCalled();
    });

    it("does not save a connection when Reddit rejects the code", async () => {
      mocks.exchangeOAuthCode.mockRejectedValue(new Error("denied"));

      const response = await callbackGet(callbackRequest("abc", "abc"));

      expect(response.headers.get("location")).toBe(
        "https://app.test/library?redditError=authorization_failed",
      );
      expect(mocks.saveRedditConnection).not.toHaveBeenCalled();
    });
  });

  describe("connection", () => {
    it("returns the stored connection for the signed-in user", async () => {
      mocks.getRedditConnection.mockResolvedValue({
        connected: true,
        redditUsername: "savesort_user",
      });

      const response = await connectionGet();

      expect(await response.json()).toEqual({
        connection: { connected: true, redditUsername: "savesort_user" },
      });
      expect(mocks.getRedditConnection).toHaveBeenCalledWith(userId);
    });

    it("disconnects the signed-in user's account", async () => {
      mocks.disconnectReddit.mockResolvedValue(undefined);

      const response = await connectionDelete();

      expect(await response.json()).toEqual({ disconnected: true });
      expect(mocks.disconnectReddit).toHaveBeenCalledWith(userId);
    });

    it("requires a signed-in user to disconnect", async () => {
      mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

      const response = await connectionDelete();

      expect(response.status).toBe(401);
      expect(mocks.disconnectReddit).not.toHaveBeenCalled();
    });
  });
});
