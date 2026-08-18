import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  exchangeOAuthCode,
  getConnectedChannel,
  googleUserIdFromIdToken,
  listPlaylistItemsPage,
  listPlaylistsPage,
  listVideos,
  refreshOAuthToken,
  YouTubeApiError,
} from "@/lib/youtube/api";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function idTokenFor(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("YouTube API client", () => {
  beforeEach(() => {
    process.env.YOUTUBE_CLIENT_ID = "client-id";
    process.env.YOUTUBE_CLIENT_SECRET = "client-secret";
    process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = "unused";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    delete process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
  });

  it("exchanges a code with the configured client credentials", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        id_token: idTokenFor("google-sub-1"),
      }),
    );

    const token = await exchangeOAuthCode(
      "the-code",
      "https://app.test/api/youtube/callback",
    );

    expect(token.refresh_token).toBe("refresh");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("client_secret=client-secret");
  });

  it("keeps the stored refresh token when a refresh omits one", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: "fresh", expires_in: 3600, scope: "s" }),
    );

    const token = await refreshOAuthToken("durable-refresh");

    expect(token.access_token).toBe("fresh");
    expect(token.refresh_token).toBeUndefined();
  });

  it("reads the Google account id from the id token", () => {
    expect(googleUserIdFromIdToken(idTokenFor("abc123"))).toBe("abc123");
    expect(googleUserIdFromIdToken("not-a-jwt")).toBeNull();
    expect(googleUserIdFromIdToken("a.!!!.c")).toBeNull();
  });

  it("treats 403 as a quota problem rather than a reconnect prompt", async () => {
    // Reconnecting cannot fix an exhausted quota, so these must not be
    // classified as unauthorized.
    fetchMock.mockResolvedValue(jsonResponse({}, 403));

    await expect(listPlaylistsPage("token", null)).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("maps 401 to unauthorized so the caller refreshes the token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await expect(listPlaylistsPage("token", null)).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  it("returns a connection even when the account has no channel", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    const channel = await getConnectedChannel("token", "google-sub-1");

    expect(channel).toEqual({
      googleUserId: "google-sub-1",
      channelId: null,
      title: null,
      thumbnailUrl: null,
    });
  });

  it("reads the channel title and thumbnail when present", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "UC123",
            snippet: {
              title: "My Channel",
              thumbnails: { medium: { url: "https://img.test/a.jpg" } },
            },
          },
        ],
      }),
    );

    const channel = await getConnectedChannel("token", "google-sub-1");

    expect(channel.channelId).toBe("UC123");
    expect(channel.title).toBe("My Channel");
    expect(channel.thumbnailUrl).toBe("https://img.test/a.jpg");
  });

  it("parses playlists and their page token", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "PL1",
            snippet: { title: "GRAPPlin Test" },
            contentDetails: { itemCount: 4 },
          },
        ],
        nextPageToken: "TOKEN2",
      }),
    );

    const page = await listPlaylistsPage("token", null);

    expect(page.playlists).toEqual([
      {
        playlistId: "PL1",
        title: "GRAPPlin Test",
        itemCount: 4,
        thumbnailUrl: null,
      },
    ]);
    expect(page.nextPageToken).toBe("TOKEN2");
  });

  it("counts playlist entries with no video id as skipped", async () => {
    // Private or deleted videos still occupy a playlist slot but expose no id.
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          { contentDetails: { videoId: "vid1" } },
          { contentDetails: {} },
          { snippet: {} },
        ],
      }),
    );

    const page = await listPlaylistItemsPage("token", "PL1", null);

    expect(page.videoIds).toEqual(["vid1"]);
    expect(page.skippedCount).toBe(2);
    expect(page.nextPageToken).toBeNull();
  });

  it("sends the page token when continuing a playlist", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    await listPlaylistItemsPage("token", "PL1", "TOKEN2");

    expect(String(fetchMock.mock.calls[0]![0])).toContain("pageToken=TOKEN2");
  });

  it("batches video ids into a single request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));

    await listVideos("token", ["a", "b", "c"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("id=a%2Cb%2Cc");
  });

  it("does not call the API for an empty id list", async () => {
    await expect(listVideos("token", [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a batch larger than one page", async () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => `v${index}`);

    await expect(listVideos("token", tooMany)).rejects.toBeInstanceOf(
      YouTubeApiError,
    );
  });

  it("parses video metadata including statistics", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "vid1",
            snippet: {
              title: "Local-first sync",
              description: "A talk",
              channelTitle: "Some Channel",
              publishedAt: "2026-01-01T00:00:00Z",
              tags: ["databases", "sync"],
              thumbnails: { high: { url: "https://img.test/v.jpg" } },
            },
            contentDetails: { duration: "PT12M30S" },
            statistics: { viewCount: "1234" },
          },
        ],
      }),
    );

    const [video] = await listVideos("token", ["vid1"]);

    expect(video).toMatchObject({
      videoId: "vid1",
      title: "Local-first sync",
      channelTitle: "Some Channel",
      durationIso: "PT12M30S",
      viewCount: 1234,
      tags: ["databases", "sync"],
    });
  });

  it("fails cleanly when YouTube is not configured", async () => {
    delete process.env.YOUTUBE_CLIENT_ID;

    await expect(
      exchangeOAuthCode("code", "https://app.test/cb"),
    ).rejects.toMatchObject({ kind: "provider_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
