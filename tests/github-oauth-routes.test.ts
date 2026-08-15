import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  disconnectGitHub: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  getAuthenticatedGitHubUser: vi.fn(),
  getGitHubConnection: vi.fn(),
  requireUser: vi.fn(),
  saveGitHubConnection: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/lib/github/api", () => ({
  exchangeOAuthCode: mocks.exchangeOAuthCode,
  getAuthenticatedGitHubUser: mocks.getAuthenticatedGitHubUser,
}));

vi.mock("@/lib/github/connections", () => ({
  disconnectGitHub: mocks.disconnectGitHub,
  getGitHubConnection: mocks.getGitHubConnection,
  saveGitHubConnection: mocks.saveGitHubConnection,
}));

import { GET as callbackGet } from "@/app/api/github/callback/route";
import { GET as connectGet } from "@/app/api/github/connect/route";
import {
  DELETE as connectionDelete,
  GET as connectionGet,
} from "@/app/api/github/connection/route";

const userId = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";
const stateCookie = "savesort_github_state";
const pkceCookie = "savesort_github_pkce";

let currentRequest: NextRequest | null;

function request(url: string, cookie?: string): NextRequest {
  const nextRequest = new NextRequest(url, {
    ...(cookie ? { headers: { cookie } } : {}),
  });
  currentRequest = nextRequest;
  return nextRequest;
}

function expectAttemptCookiesCleared(response: Response) {
  const cookies = (
    response as Response & {
      cookies: { get(name: string): { maxAge?: number; value: string } };
    }
  ).cookies;

  expect(cookies.get(stateCookie)).toMatchObject({ value: "", maxAge: 0 });
  expect(cookies.get(pkceCookie)).toMatchObject({ value: "", maxAge: 0 });
}

describe("GitHub OAuth routes", () => {
  beforeEach(() => {
    currentRequest = null;
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "github-client-id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "server-secret");
    vi.stubEnv(
      "GITHUB_TOKEN_ENCRYPTION_KEY",
      Buffer.alloc(32).toString("base64"),
    );
    vi.stubEnv("SUPABASE_SECRET_KEY", "supabase-secret");

    mocks.cookies.mockReset();
    mocks.cookies.mockImplementation(async () => ({
      get(name: string) {
        return currentRequest?.cookies.get(name);
      },
    }));
    mocks.disconnectGitHub.mockReset().mockResolvedValue(undefined);
    mocks.exchangeOAuthCode.mockReset().mockResolvedValue({
      access_token: "github-access-token",
      refresh_token: "github-refresh-token",
      expires_in: 28_800,
      refresh_token_expires_in: 15_811_200,
    });
    mocks.getAuthenticatedGitHubUser.mockReset().mockResolvedValue({
      id: 1,
      login: "octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    });
    mocks.getGitHubConnection.mockReset().mockResolvedValue(null);
    mocks.requireUser.mockReset().mockResolvedValue({
      supabase: {},
      user: { id: userId },
    });
    mocks.saveGitHubConnection.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("redirects an authenticated user with a bounded PKCE attempt", async () => {
    const response = await connectGet(
      request("http://localhost:3000/api/github/connect"),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect([...location.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "state",
    ]);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: "github-client-id",
      code_challenge_method: "S256",
      redirect_uri: "http://localhost:3000/api/github/callback",
    });
    expect(location.search).not.toContain("server-secret");
    expect(location.searchParams.has("scope")).toBe(false);

    const state = response.cookies.get(stateCookie);
    const pkce = response.cookies.get(pkceCookie);
    expect(state).toMatchObject({
      httpOnly: true,
      maxAge: 600,
      path: "/",
      sameSite: "lax",
    });
    expect(pkce).toMatchObject({
      httpOnly: true,
      maxAge: 600,
      path: "/",
      sameSite: "lax",
    });
    expect(location.searchParams.get("state")).toBe(state?.value);
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256")
        .update(pkce?.value ?? "")
        .digest("base64url"),
    );
  });

  it("returns a safe 401 instead of starting OAuth without a SaveSort user", async () => {
    mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

    const response = await connectGet(
      request("http://localhost:3000/api/github/connect"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Please sign in to continue.",
    });
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  it("rejects mismatched state before exchanging the authorization code", async () => {
    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?code=code-1&state=wrong",
        "savesort_github_state=expected",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/library?githubError=authorization_failed",
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    expectAttemptCookiesCleared(response);
  });

  it("rejects missing callback values and clears both attempt cookies", async () => {
    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?state=expected",
        "savesort_github_state=expected; savesort_github_pkce=verifier",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/library?githubError=authorization_failed",
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    expectAttemptCookiesCleared(response);
  });

  it("rejects oversized callback state before provider work", async () => {
    const oversizedState = "a".repeat(257);
    const response = await callbackGet(
      request(
        `http://localhost:3000/api/github/callback?code=code-1&state=${oversizedState}`,
        `savesort_github_state=${oversizedState}; savesort_github_pkce=verifier`,
      ),
    );

    expect(response.headers.get("location")).toContain(
      "/library?githubError=authorization_failed",
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    expectAttemptCookiesCleared(response);
  });

  it("rejects oversized PKCE cookies before provider work", async () => {
    const oversizedVerifier = "v".repeat(257);
    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?code=code-1&state=expected",
        `savesort_github_state=expected; savesort_github_pkce=${oversizedVerifier}`,
      ),
    );

    expect(response.headers.get("location")).toContain(
      "/library?githubError=authorization_failed",
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    expectAttemptCookiesCleared(response);
  });

  it("exchanges the exact callback, revalidates /user, and saves the connection", async () => {
    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?code=code-1&state=expected",
        "savesort_github_state=expected; savesort_github_pkce=verifier-1",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/library?githubSync=connect",
    );
    expect(mocks.exchangeOAuthCode).toHaveBeenCalledWith(
      "code-1",
      "verifier-1",
      "http://localhost:3000/api/github/callback",
    );
    expect(mocks.getAuthenticatedGitHubUser).toHaveBeenCalledWith(
      "github-access-token",
    );
    expect(mocks.saveGitHubConnection).toHaveBeenCalledWith(
      userId,
      {
        id: 1,
        login: "octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      },
      {
        access_token: "github-access-token",
        refresh_token: "github-refresh-token",
        expires_in: 28_800,
        refresh_token_expires_in: 15_811_200,
      },
    );
    expectAttemptCookiesCleared(response);
  });

  it("redirects unauthenticated callbacks safely and clears the attempt", async () => {
    mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?code=code-1&state=expected",
        "savesort_github_state=expected; savesort_github_pkce=verifier-1",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "/library?githubError=authorization_failed",
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
    expectAttemptCookiesCleared(response);
  });

  it("does not expose provider failures from the callback", async () => {
    mocks.exchangeOAuthCode.mockRejectedValue(
      new Error("secret provider response containing code-1"),
    );

    const response = await callbackGet(
      request(
        "http://localhost:3000/api/github/callback?code=code-1&state=expected",
        "savesort_github_state=expected; savesort_github_pkce=verifier-1",
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/library?githubError=authorization_failed",
    );
    expect(response.headers.get("location")).not.toContain("code-1");
    expectAttemptCookiesCleared(response);
  });

  it("returns only safe connection metadata", async () => {
    mocks.getGitHubConnection.mockResolvedValue({
      connected: true,
      githubLogin: "octocat",
      githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      connectionStatus: "connected",
      syncStatus: "idle",
      lastSyncedAt: null,
      discoveredCount: 3,
      savedCount: 2,
      skippedCount: 1,
      lastSyncError: null,
    });

    const response = await connectionGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      connection: {
        connected: true,
        githubLogin: "octocat",
        githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        connectionStatus: "connected",
        syncStatus: "idle",
        lastSyncedAt: null,
        discoveredCount: 3,
        savedCount: 2,
        skippedCount: 1,
        lastSyncError: null,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|secret/i);
  });

  it("returns safe JSON errors from connection routes", async () => {
    mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

    const getResponse = await connectionGet();
    const deleteResponse = await connectionDelete();

    expect(getResponse.status).toBe(401);
    await expect(getResponse.json()).resolves.toEqual({
      error: "Please sign in to continue.",
    });
    expect(deleteResponse.status).toBe(401);
    await expect(deleteResponse.json()).resolves.toEqual({
      error: "Please sign in to continue.",
    });
  });

  it("disconnects only the authenticated user's GitHub connection", async () => {
    const response = await connectionDelete();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disconnected: true });
    expect(mocks.disconnectGitHub).toHaveBeenCalledWith(userId);
  });
});
