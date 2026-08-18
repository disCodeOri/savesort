import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  exchangeOAuthCode,
  getAuthenticatedAccount,
  listBookmarksPage,
  parseRateLimit,
  refreshOAuthToken,
  XApiError,
} from "@/lib/x/api";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("X API client", () => {
  beforeEach(() => {
    process.env.X_CLIENT_ID = "client-id";
    process.env.X_CLIENT_SECRET = "client-secret";
    process.env.X_TOKEN_ENCRYPTION_KEY = "unused";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
    delete process.env.X_TOKEN_ENCRYPTION_KEY;
  });

  it("authenticates the confidential client with HTTP Basic at the token endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 7200,
        scope: "tweet.read users.read bookmark.read offline.access",
        token_type: "bearer",
      }),
    );

    const token = await exchangeOAuthCode(
      "the-code",
      "the-verifier",
      "https://app.test/api/x/callback",
    );

    expect(token.refresh_token).toBe("refresh");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=the-verifier");
  });

  it("sends the refresh grant when renewing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "fresh",
        refresh_token: "rotated",
        expires_in: 7200,
        scope: "tweet.read",
        token_type: "bearer",
      }),
    );

    const token = await refreshOAuthToken("old-refresh");

    expect(token.access_token).toBe("fresh");
    expect(token.refresh_token).toBe("rotated");
    expect(String(fetchMock.mock.calls[0]![1]!.body)).toContain(
      "grant_type=refresh_token",
    );
  });

  it("reads the connected identity from the token, not from any input", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          id: "42",
          username: "someone",
          name: "Some One",
          profile_image_url: "https://pbs.twimg.com/a.jpg",
        },
      }),
    );

    const account = await getAuthenticatedAccount("access");

    expect(account).toEqual({
      id: "42",
      username: "someone",
      name: "Some One",
      profileImageUrl: "https://pbs.twimg.com/a.jpg",
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/2/users/me");
  });

  it("maps 401 to unauthorized so the caller can refresh once", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await expect(listBookmarksPage("t", "42", null)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("maps 429 to rate_limited and carries the reset time", async () => {
    const resetSeconds = 1_800_000_000;
    fetchMock.mockResolvedValue(
      jsonResponse({}, 429, {
        "x-rate-limit-reset": String(resetSeconds),
        "x-rate-limit-remaining": "0",
      }),
    );

    const error = await listBookmarksPage("t", "42", null).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(XApiError);
    expect((error as XApiError).kind).toBe("rate_limited");
    expect((error as XApiError).rateLimit?.resetAt?.getTime()).toBe(
      resetSeconds * 1_000,
    );
  });

  it("distinguishes a scope problem from a plan problem on 403", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "Missing required scope bookmark.read" }, 403),
    );
    const scopeError = (await listBookmarksPage("t", "42", null).then(
      () => null,
      (caught: unknown) => caught,
    )) as XApiError;
    expect(scopeError.kind).toBe("forbidden");
    expect(scopeError.detail).toContain("Reconnect");

    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: "Your current access level does not include..." },
        403,
      ),
    );
    const planError = (await listBookmarksPage("t", "42", null).then(
      () => null,
      (caught: unknown) => caught,
    )) as XApiError;
    expect(planError.detail).toContain("access level");
  });

  it("requests only retrieval-useful fields and no engagement metrics", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: {} }));

    await listBookmarksPage("t", "42", null);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/2/users/42/bookmarks");
    expect(url).toContain("max_results=100");
    expect(url).toContain("referenced_tweets");
    // Engagement metrics cost payload and add nothing to search.
    expect(url).not.toContain("public_metrics");
  });

  it("sends the pagination token when continuing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: {} }));

    await listBookmarksPage("t", "42", "TOKEN2");

    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "pagination_token=TOKEN2",
    );
  });

  it("parses posts with their author, media and referenced expansions", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "1",
            text: "hello",
            author_id: "a1",
            created_at: "2026-02-01T00:00:00.000Z",
            entities: {
              urls: [
                {
                  expanded_url: "https://example.com/a",
                  unwound_url: "https://example.com/final",
                },
              ],
            },
            attachments: { media_keys: ["m1"] },
            referenced_tweets: [{ type: "quoted", id: "9" }],
          },
        ],
        includes: {
          users: [{ id: "a1", username: "someone", name: "Some One" }],
          media: [
            {
              media_key: "m1",
              type: "photo",
              preview_image_url: "https://img/x.jpg",
            },
          ],
          tweets: [{ id: "9", text: "quoted text", author_id: "a1" }],
        },
        meta: { next_token: "NEXT" },
      }),
    );

    const page = await listBookmarksPage("t", "42", null);

    expect(page.posts).toHaveLength(1);
    // unwound_url is preferred: it is the real destination, not the redirect.
    expect(page.posts[0]!.urls).toEqual(["https://example.com/final"]);
    expect(page.authorsById.get("a1")?.username).toBe("someone");
    expect(page.mediaByKey.get("m1")?.type).toBe("photo");
    expect(page.referencedPostsById.get("9")?.text).toBe("quoted text");
    expect(page.nextToken).toBe("NEXT");
    expect(page.resultCount).toBe(1);
  });

  it("reports no next token when the listing ends", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: {} }));

    const page = await listBookmarksPage("t", "42", null);

    expect(page.nextToken).toBeNull();
    expect(page.posts).toEqual([]);
  });

  it("counts malformed entries so page accounting stays balanced", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: "1", text: "ok" }, { text: "no id" }],
        meta: {},
      }),
    );

    const page = await listBookmarksPage("t", "42", null);

    expect(page.posts).toHaveLength(1);
    expect(page.resultCount).toBe(2);
  });

  it("treats a network failure as a provider error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    await expect(listBookmarksPage("t", "42", null)).rejects.toMatchObject({
      kind: "provider_error",
    });
  });

  it("fails cleanly when X is not configured", async () => {
    delete process.env.X_CLIENT_ID;

    await expect(
      exchangeOAuthCode("c", "v", "https://app.test/cb"),
    ).rejects.toMatchObject({ kind: "provider_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseRateLimit", () => {
  it("reads the documented rate-limit headers", () => {
    const limit = parseRateLimit(
      new Headers({
        "x-rate-limit-limit": "75",
        "x-rate-limit-remaining": "3",
        "x-rate-limit-reset": "1800000000",
      }),
    );

    expect(limit.limit).toBe(75);
    expect(limit.remaining).toBe(3);
    expect(limit.resetAt?.getTime()).toBe(1_800_000_000_000);
  });

  it("returns nulls when the headers are absent", () => {
    const limit = parseRateLimit(new Headers());

    expect(limit).toEqual({ limit: null, remaining: null, resetAt: null });
  });
});
