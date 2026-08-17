import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  exchangeOAuthCode,
  getRedditIdentity,
  listSavedPostsPage,
  RedditApiError,
  refreshOAuthToken,
} from "@/lib/reddit/api";

const fetchMock = vi.fn<typeof fetch>();
const USER_AGENT = "web:savesort:v0.1 (by /u/savesort)";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function post(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "t3",
    data: {
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
      score: 12,
      num_comments: 3,
      created_utc: 1_700_000_000,
      over_18: false,
      is_self: false,
      ...overrides,
    },
  };
}

function listing(children: unknown[], after: string | null = null) {
  return { kind: "Listing", data: { after, dist: children.length, children } };
}

describe("Reddit API client", () => {
  beforeEach(() => {
    process.env.REDDIT_APP_CLIENT_ID = "client-id";
    process.env.REDDIT_APP_CLIENT_SECRET = "client-secret";
    process.env.REDDIT_TOKEN_ENCRYPTION_KEY = "unused";
    process.env.REDDIT_USER_AGENT = USER_AGENT;
    process.env.SUPABASE_SECRET_KEY = "unused";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.REDDIT_APP_CLIENT_ID;
    delete process.env.REDDIT_APP_CLIENT_SECRET;
    delete process.env.REDDIT_TOKEN_ENCRYPTION_KEY;
    delete process.env.REDDIT_USER_AGENT;
    delete process.env.SUPABASE_SECRET_KEY;
  });

  it("exchanges a code with HTTP Basic client credentials", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: "identity history",
      }),
    );

    const token = await exchangeOAuthCode(
      "the-code",
      "https://app.test/api/reddit/callback",
    );

    expect(token.refresh_token).toBe("refresh");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.reddit.com/api/v1/access_token");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(headers["User-Agent"]).toBe(USER_AGENT);
    expect(String((init as RequestInit).body)).toContain(
      "grant_type=authorization_code",
    );
  });

  it("treats an invalid_grant body on HTTP 200 as unauthorized", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid_grant" }));

    await expect(refreshOAuthToken("stale-refresh")).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("keeps a refresh response that omits a new refresh token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "fresh",
        expires_in: 3600,
        scope: "identity history",
      }),
    );

    const token = await refreshOAuthToken("durable-refresh");

    expect(token.access_token).toBe("fresh");
    expect(token.refresh_token).toBeUndefined();
  });

  it("reads the connected account from the token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "2fp8x",
        name: "savesort_user",
        icon_img: "https://styles.redditmedia.com/avatar.png",
      }),
    );

    const identity = await getRedditIdentity("access");

    expect(identity).toEqual({
      id: "2fp8x",
      name: "savesort_user",
      icon_img: "https://styles.redditmedia.com/avatar.png",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth.reddit.com/api/v1/me?raw_json=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access",
          "User-Agent": USER_AGENT,
        }),
      }),
    );
  });

  it("requests one 100-item page of saved links and returns the cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        listing(
          Array.from({ length: 100 }, (_, index) => post(`p${index}`)),
          "t3_p99",
        ),
      ),
    );

    const page = await listSavedPostsPage("access", "savesort_user", null);

    expect(page.posts).toHaveLength(100);
    expect(page.discoveredCount).toBe(100);
    expect(page.nextCursor).toBe("t3_p99");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth.reddit.com/user/savesort_user/saved?limit=100&type=links&raw_json=1",
      expect.anything(),
    );
  });

  it("sends the cursor as after on later pages", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listing([post("a")])));

    await listSavedPostsPage("access", "savesort_user", "t3_p99");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth.reddit.com/user/savesort_user/saved?limit=100&type=links&raw_json=1&after=t3_p99",
      expect.anything(),
    );
  });

  it("escapes the username in the listing path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listing([])));

    await listSavedPostsPage("access", "odd/name", null);

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/user/odd%2Fname/");
  });

  it("counts children it cannot use without failing the page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        listing([
          post("a"),
          { kind: "t1", data: { id: "c1", body: "a saved comment" } },
          { kind: "t3", data: { id: "b" } },
        ]),
      ),
    );

    const page = await listSavedPostsPage("access", "savesort_user", null);

    expect(page.posts).toHaveLength(1);
    expect(page.discoveredCount).toBe(3);
  });

  it("stops paging when the cursor does not move", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listing([post("a")], "t3_same")));

    const page = await listSavedPostsPage("access", "savesort_user", "t3_same");

    expect(page.nextCursor).toBeNull();
  });

  it("reports an empty page that still has a cursor as running", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listing([], "t3_next")));

    const page = await listSavedPostsPage("access", "savesort_user", null);

    expect(page.posts).toEqual([]);
    expect(page.discoveredCount).toBe(0);
    expect(page.nextCursor).toBe("t3_next");
  });

  it("classifies 401 and 403 as unauthorized and 429 as rate limited", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(jsonResponse({}, status));
      await expect(
        listSavedPostsPage("access", "savesort_user", null),
      ).rejects.toMatchObject({ kind: "unauthorized" });
    }

    fetchMock.mockResolvedValue(jsonResponse({}, 429));
    await expect(
      listSavedPostsPage("access", "savesort_user", null),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("rejects a listing envelope it does not recognize", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ kind: "t3", data: {} }));

    await expect(
      listSavedPostsPage("access", "savesort_user", null),
    ).rejects.toBeInstanceOf(RedditApiError);
  });

  it("fails when Reddit is not configured", async () => {
    delete process.env.REDDIT_USER_AGENT;

    await expect(getRedditIdentity("access")).rejects.toMatchObject({
      kind: "provider_error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
