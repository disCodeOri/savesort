import { describe, expect, it } from "vitest";

import {
  availabilityFor,
  canonicalUrl,
  extractPostId,
  normalizeRecord,
  unwrapRecord,
  usernameFromUrl,
} from "@/lib/x-archive/normalize";
import { isEligibleForAi, reconcileRecords } from "@/lib/x-archive/reconcile";

const LONG_TEXT =
  "Most AI agent architectures do not actually need a vector database, and here is the reasoning behind that claim in detail.";

describe("post identity", () => {
  it("reads the id from any historical field spelling", () => {
    expect(extractPostId({ tweetId: "1900000000000000000" })).toBe(
      "1900000000000000000",
    );
    expect(extractPostId({ tweet_id: "1900000000000000001" })).toBe(
      "1900000000000000001",
    );
    expect(extractPostId({ id_str: "1900000000000000002" })).toBe(
      "1900000000000000002",
    );
    expect(extractPostId({ post_id: "1900000000000000003" })).toBe(
      "1900000000000000003",
    );
  });

  it("recovers the id from a status URL when no id field exists", () => {
    expect(
      extractPostId({
        expandedUrl: "https://twitter.com/user/status/123456789",
      }),
    ).toBe("123456789");
  });

  it("rejects values that are not plausible post ids", () => {
    expect(extractPostId({ id: "not-an-id" })).toBeNull();
    expect(extractPostId({})).toBeNull();
  });

  it("accepts the very short ids that early Twitter issued", () => {
    // The first tweet is id 20. A historical archive is exactly where these
    // appear, so they must not be discarded as implausible.
    expect(extractPostId({ id_str: "20" })).toBe("20");
    expect(
      extractPostId({ expandedUrl: "https://twitter.com/jack/status/20" }),
    ).toBe("20");
  });

  it("normalizes twitter.com and x.com to one canonical URL", () => {
    // Both hosts must collapse to the same identity or the API and archive
    // would create two rows for one post.
    expect(canonicalUrl("123", "user")).toBe("https://x.com/user/status/123");
    expect(usernameFromUrl("https://twitter.com/user/status/123")).toBe("user");
    expect(usernameFromUrl("https://x.com/user/status/123")).toBe("user");
  });

  it("unwraps the single-key envelope archives use", () => {
    expect(unwrapRecord({ like: { tweetId: "1" } })).toEqual({ tweetId: "1" });
    expect(unwrapRecord({ tweetId: "1" })).toEqual({ tweetId: "1" });
    expect(unwrapRecord("nope")).toBeNull();
  });
});

describe("availabilityFor", () => {
  it("grades content by how much text actually exists", () => {
    expect(availabilityFor(null)).toBe("reference_only");
    expect(availabilityFor("   ")).toBe("reference_only");
    expect(availabilityFor("short note")).toBe("partial");
    expect(availabilityFor(LONG_TEXT)).toBe("full");
  });
});

describe("normalizeRecord", () => {
  it("creates a reference-only record when only an id exists", () => {
    const record = normalizeRecord(
      { like: { tweetId: "1900000000000000000" } },
      "like",
      "data/like.js",
    )!;

    expect(record.postId).toBe("1900000000000000000");
    // Never fabricated.
    expect(record.text).toBeNull();
    expect(record.canonicalUrl).toBe(
      "https://x.com/i/status/1900000000000000000",
    );
  });

  it("keeps full text and entities when the archive supplies them", () => {
    const record = normalizeRecord(
      {
        tweet: {
          id_str: "123456789",
          full_text: LONG_TEXT,
          created_at: "2026-01-01T00:00:00.000Z",
          entities: {
            hashtags: [{ text: "AI" }],
            user_mentions: [{ screen_name: "someone" }],
            urls: [
              { expanded_url: "https://example.com/post" },
              { expanded_url: "https://t.co/shortened" },
            ],
          },
        },
      },
      "own_post",
      "data/tweets.js",
    )!;

    expect(record.text).toBe(LONG_TEXT);
    expect(record.hashtags).toEqual(["AI"]);
    expect(record.mentions).toEqual(["someone"]);
    // t.co shorteners carry no meaning and are dropped.
    expect(record.externalUrls).toEqual(["https://example.com/post"]);
  });

  it("prefers an explicit username over one inferred from a URL", () => {
    const record = normalizeRecord(
      {
        like: {
          tweetId: "123456789",
          screenName: "realname",
          expandedUrl: "https://x.com/urlname/status/123456789",
        },
      },
      "like",
      "data/like.js",
    )!;

    expect(record.authorUsername).toBe("realname");
  });

  it("never treats a post's creation time as a relationship time", () => {
    const record = normalizeRecord(
      { like: { tweetId: "123456789", created_at: "2026-01-01T00:00:00Z" } },
      "like",
      "data/like.js",
    )!;

    expect(record.createdAt).toBe("2026-01-01T00:00:00.000Z");
    // The archive gave no "when did you like this", so it stays null.
    expect(record.relationships[0]!.timestamp).toBeNull();
  });

  it("uses a genuine relationship timestamp when present", () => {
    const record = normalizeRecord(
      {
        bookmark: {
          tweetId: "123456789",
          bookmarkedAt: "2026-02-02T10:00:00Z",
        },
      },
      "bookmark",
      "data/bookmarks.js",
    )!;

    expect(record.relationships[0]!.timestamp).toBe("2026-02-02T10:00:00.000Z");
  });

  it("classifies a retweet in the post history as a repost, not authorship", () => {
    const record = normalizeRecord(
      {
        tweet: { id_str: "123456789", full_text: "RT @someone: original text" },
      },
      "own_post",
      "data/tweets.js",
    )!;

    expect(record.relationships[0]!.type).toBe("repost");
  });

  it("ignores a malformed timestamp rather than failing", () => {
    const record = normalizeRecord(
      { like: { tweetId: "123456789", created_at: "not a date" } },
      "like",
      "data/like.js",
    )!;

    expect(record.createdAt).toBeNull();
  });

  it("drops a record with no usable identity", () => {
    expect(
      normalizeRecord({ like: { text: "orphan" } }, "like", "f.js"),
    ).toBeNull();
  });
});

describe("reconcileRecords", () => {
  it("merges the same post across datasets into one item with both relationships", () => {
    // The core requirement: liked AND bookmarked is one content item, not two.
    const items = reconcileRecords([
      normalizeRecord({ like: { tweetId: "123456789" } }, "like", "like.js")!,
      normalizeRecord(
        { bookmark: { tweetId: "123456789" } },
        "bookmark",
        "bookmarks.js",
      )!,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]!.relationships.map((r) => r.type).sort()).toEqual([
      "bookmark",
      "like",
    ]);
    expect(items[0]!.sourceFiles).toEqual(["like.js", "bookmarks.js"]);
  });

  it("upgrades a reference-only record when another file supplies the text", () => {
    const items = reconcileRecords([
      normalizeRecord({ like: { tweetId: "123456789" } }, "like", "like.js")!,
      normalizeRecord(
        { tweet: { id_str: "123456789", full_text: LONG_TEXT } },
        "own_post",
        "tweets.js",
      )!,
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe(LONG_TEXT);
    expect(items[0]!.contentAvailability).toBe("full");
  });

  it("never replaces richer text with a poorer value", () => {
    const items = reconcileRecords([
      normalizeRecord(
        { tweet: { id_str: "123456789", full_text: LONG_TEXT } },
        "own_post",
        "tweets.js",
      )!,
      normalizeRecord(
        { like: { tweetId: "123456789", text: "short" } },
        "like",
        "like.js",
      )!,
    ]);

    expect(items[0]!.text).toBe(LONG_TEXT);
  });

  it("improves the canonical URL once a username is discovered", () => {
    const items = reconcileRecords([
      normalizeRecord({ like: { tweetId: "123456789" } }, "like", "like.js")!,
      normalizeRecord(
        { tweet: { id_str: "123456789", screen_name: "author" } },
        "own_post",
        "tweets.js",
      )!,
    ]);

    expect(items[0]!.canonicalUrl).toBe(
      "https://x.com/author/status/123456789",
    );
  });

  it("keeps distinct posts separate", () => {
    const items = reconcileRecords([
      normalizeRecord({ like: { tweetId: "111111111" } }, "like", "like.js")!,
      normalizeRecord({ like: { tweetId: "222222222" } }, "like", "like.js")!,
    ]);

    expect(items).toHaveLength(2);
  });

  it("keeps a real relationship timestamp when merging", () => {
    const items = reconcileRecords([
      normalizeRecord({ like: { tweetId: "123456789" } }, "like", "a.js")!,
      normalizeRecord(
        { like: { tweetId: "123456789", likedAt: "2026-03-03T00:00:00Z" } },
        "like",
        "b.js",
      )!,
    ]);

    expect(items[0]!.relationships[0]!.timestamp).toBe(
      "2026-03-03T00:00:00.000Z",
    );
  });
});

describe("isEligibleForAi", () => {
  it("refuses to classify or embed a bare post id", () => {
    const [referenceOnly] = reconcileRecords([
      normalizeRecord({ like: { tweetId: "123456789" } }, "like", "like.js")!,
    ]);
    expect(isEligibleForAi(referenceOnly!)).toBe(false);
  });

  it("allows content with real text", () => {
    const [full] = reconcileRecords([
      normalizeRecord(
        { tweet: { id_str: "123456789", full_text: LONG_TEXT } },
        "own_post",
        "tweets.js",
      )!,
    ]);
    expect(isEligibleForAi(full!)).toBe(true);
  });
});
