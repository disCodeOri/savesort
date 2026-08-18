import { describe, expect, it } from "vitest";

import { mapXBookmark, xPostUrl } from "@/lib/x/map-bookmark";
import type { XAccount, XMedia, XPost } from "@/lib/x/types";

function post(overrides: Partial<XPost> = {}): XPost {
  return {
    id: "1750000000000000001",
    text: "Here's why most AI agent architectures don't need a vector DB.",
    authorId: "author-1",
    createdAt: "2026-02-01T12:00:00.000Z",
    lang: "en",
    conversationId: "1750000000000000001",
    urls: [],
    mediaKeys: [],
    referencedPostIds: [],
    ...overrides,
  };
}

const author: XAccount = {
  id: "author-1",
  username: "someone",
  name: "Some One",
  profileImageUrl: "https://pbs.twimg.com/a.jpg",
};

function authors(...accounts: XAccount[]): Map<string, XAccount> {
  return new Map(accounts.map((account) => [account.id, account]));
}

describe("xPostUrl", () => {
  it("builds a canonical permalink", () => {
    expect(xPostUrl("someone", "123")).toBe("https://x.com/someone/status/123");
  });

  it("falls back to /i when the author is unknown", () => {
    expect(xPostUrl(null, "123")).toBe("https://x.com/i/status/123");
  });
});

describe("mapXBookmark", () => {
  it("uses the canonical post URL as stable identity", () => {
    const item = mapXBookmark(post(), authors(author), new Map(), new Map());

    expect(item.url).toBe("https://x.com/someone/status/1750000000000000001");
    expect(item.normalized_url).toBe(item.url);
    expect(item.source).toBe("x");
    expect(item.post_id).toBe("1750000000000000001");
  });

  it("keeps the full post text searchable while shortening the title", () => {
    const long = "word ".repeat(60);
    const item = mapXBookmark(
      post({ text: long }),
      authors(author),
      new Map(),
      new Map(),
    );

    expect(item.title.length).toBeLessThanOrEqual(120);
    expect(item.content).toContain("word word");
    expect(item.searchable_text).toContain("word word");
  });

  it("records the post time as provider metadata, never as a bookmark time", () => {
    const item = mapXBookmark(post(), authors(author), new Map(), new Map());

    expect(item.metadata.x.postedAt).toBe("2026-02-01T12:00:00.000Z");
    // There is no bookmarkedAt field; X does not expose one.
    expect(Object.keys(item.metadata.x)).not.toContain("bookmarkedAt");
  });

  it("makes the author name and @username searchable", () => {
    const item = mapXBookmark(post(), authors(author), new Map(), new Map());

    expect(item.author).toBe("Some One (@someone)");
    expect(item.searchable_text).toContain("@someone");
    expect(item.searchable_text).toContain("Some One");
  });

  it("folds quoted post text into the body so short reactions stay findable", () => {
    // "This is exactly right" is useless alone; the quoted post carries the meaning.
    const quotedAuthor: XAccount = {
      id: "author-2",
      username: "quoted",
      name: "Quoted Person",
      profileImageUrl: null,
    };
    const quoted = post({
      id: "999",
      authorId: "author-2",
      text: "Local-first sync avoids most conflict resolution problems.",
    });

    const item = mapXBookmark(
      post({ text: "This is exactly right", referencedPostIds: ["999"] }),
      authors(author, quotedAuthor),
      new Map(),
      new Map([["999", quoted]]),
    );

    expect(item.content).toContain("Quoting @quoted:");
    expect(item.searchable_text).toContain("conflict resolution");
    expect(item.metadata.x.quotedPostId).toBe("999");
  });

  it("indexes image alt text when present", () => {
    const media: XMedia = {
      mediaKey: "m1",
      type: "photo",
      previewImageUrl: "https://pbs.twimg.com/media/x.jpg",
      altText: "A diagram of a retrieval pipeline",
    };

    const item = mapXBookmark(
      post({ mediaKeys: ["m1"] }),
      authors(author),
      new Map([["m1", media]]),
      new Map(),
    );

    expect(item.thumbnail_url).toBe("https://pbs.twimg.com/media/x.jpg");
    expect(item.searchable_text).toContain("retrieval pipeline");
    expect(item.metadata.x.mediaType).toBe("photo");
  });

  it("drops unsafe provider URLs instead of storing them", () => {
    // X-supplied URLs are untrusted; only http(s) may be persisted.
    const item = mapXBookmark(
      post({
        urls: [
          "https://example.com/good",
          "javascript:alert(1)",
          "file:///etc/passwd",
        ],
      }),
      authors(author),
      new Map(),
      new Map(),
    );

    expect(item.metadata.x.outboundUrls).toEqual(["https://example.com/good"]);
    expect(item.content).not.toContain("javascript:");
  });

  it("rejects an unsafe media preview URL", () => {
    const item = mapXBookmark(
      post({ mediaKeys: ["m1"] }),
      authors(author),
      new Map([
        [
          "m1",
          {
            mediaKey: "m1",
            type: "photo",
            previewImageUrl: "javascript:alert(1)",
            altText: null,
          },
        ],
      ]),
      new Map(),
    );

    expect(item.thumbnail_url).toBeNull();
  });

  it("still maps a post whose author expansion is missing", () => {
    const item = mapXBookmark(post(), new Map(), new Map(), new Map());

    expect(item.url).toContain("/i/status/");
    expect(item.author).toBeNull();
    expect(item.title).toContain("vector DB");
  });

  it("assigns no tags, leaving that namespace to the user", () => {
    // Sync must never write tags; they belong to the user and survive resync.
    expect(
      mapXBookmark(post(), authors(author), new Map(), new Map()).tags,
    ).toEqual([]);
  });

  it("caps the indexed document like every other source", () => {
    const item = mapXBookmark(
      post({ text: "y".repeat(50_000) }),
      authors(author),
      new Map(),
      new Map(),
    );

    expect(item.searchable_text.length).toBeLessThanOrEqual(12_000);
  });
});
