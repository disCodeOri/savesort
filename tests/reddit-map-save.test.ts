import { describe, expect, it } from "vitest";

import { mapRedditSave, mergeRedditProviderItem } from "@/lib/reddit/map-save";
import type { RedditSavedPost } from "@/lib/reddit/types";

function post(overrides: Partial<RedditSavedPost> = {}): RedditSavedPost {
  return {
    id: "abc123",
    name: "t3_abc123",
    permalink: "/r/programming/comments/abc123/a_saved_post/",
    title: "A saved  post",
    subreddit: "programming",
    subreddit_name_prefixed: "r/programming",
    author: "someone",
    url: "https://example.com/article",
    selftext: "",
    link_flair_text: "Discussion",
    thumbnail: "self",
    score: 42,
    num_comments: 7,
    created_utc: 1_700_000_000,
    over_18: false,
    is_self: false,
    ...overrides,
  };
}

describe("mapRedditSave", () => {
  it("indexes the Reddit permalink rather than the outbound link", () => {
    const item = mapRedditSave(post());

    expect(item.url).toBe(
      "https://www.reddit.com/r/programming/comments/abc123/a_saved_post",
    );
    expect(item.normalized_url).toBe(item.url);
    expect(item.source).toBe("reddit");
    expect(item.metadata.reddit.linkUrl).toBe("https://example.com/article");
  });

  it("collapses whitespace in the title and tags the subreddit and flair", () => {
    const item = mapRedditSave(post());

    expect(item.title).toBe("A saved post");
    expect(item.tags).toEqual(["r/programming", "Discussion"]);
    expect(item.metadata.reddit.providerTags).toEqual(item.tags);
  });

  it("keeps self post text as searchable content with a short excerpt", () => {
    const item = mapRedditSave(
      post({
        is_self: true,
        url: null,
        selftext: `A long body.\n\n${"x".repeat(500)}`,
      }),
    );

    expect(item.content).toContain("A long body.");
    expect(item.description).toHaveLength(300);
    expect(item.description?.endsWith("…")).toBe(true);
    expect(item.searchable_text).toContain("Content: A long body.");
    expect(item.metadata.reddit.linkUrl).toBeNull();
  });

  it("caps very long self post text", () => {
    const item = mapRedditSave(
      post({ is_self: true, selftext: "y".repeat(20_000) }),
    );

    expect(item.content).toHaveLength(10_000);
  });

  it("falls back to the outbound link when a link post has no text", () => {
    const item = mapRedditSave(post());

    expect(item.content).toBeNull();
    expect(item.description).toBe("https://example.com/article");
  });

  it("ignores Reddit's placeholder thumbnails", () => {
    for (const thumbnail of ["self", "default", "nsfw", "spoiler", ""]) {
      expect(mapRedditSave(post({ thumbnail })).thumbnail_url).toBeNull();
    }

    expect(
      mapRedditSave(
        post({ thumbnail: "https://b.thumbs.redditmedia.com/x.jpg" }),
      ).thumbnail_url,
    ).toBe("https://b.thumbs.redditmedia.com/x.jpg");
  });

  it("drops a deleted author instead of storing the placeholder", () => {
    expect(mapRedditSave(post({ author: "[deleted]" })).author).toBeNull();
    expect(mapRedditSave(post()).author).toBe("someone");
  });

  it("records the NSFW flag without skipping the post", () => {
    const item = mapRedditSave(post({ over_18: true }));

    expect(item.metadata.reddit.nsfw).toBe(true);
    expect(item.title).toBe("A saved post");
  });

  it("refuses a permalink that resolves off Reddit", () => {
    expect(() =>
      mapRedditSave(post({ permalink: "//evil.example/x" })),
    ).toThrow("That saved post does not point at Reddit.");
  });
});

describe("mergeRedditProviderItem", () => {
  const provider = mapRedditSave(post());

  it("keeps notes and hand-added tags while refreshing provider fields", () => {
    const merged = mergeRedditProviderItem(
      {
        url: provider.url,
        normalized_url: provider.normalized_url,
        title: "Old title",
        description: "Old description",
        notes: "Read this again",
        content: null,
        author: "someone",
        thumbnail_url: null,
        tags: ["read-later", "r/oldsubreddit"],
        metadata: {
          reddit: { providerTags: ["r/oldsubreddit"] },
          custom: { keep: true },
        },
      },
      provider,
    );

    expect(merged.notes).toBe("Read this again");
    expect(merged.tags).toEqual(["read-later", "r/programming", "Discussion"]);
    expect(merged.title).toBe("A saved post");
    expect(merged.metadata.custom).toEqual({ keep: true });
    expect(merged.metadata.reddit.subredditPrefixed).toBe("r/programming");
    expect(merged.searchable_text).toContain("Notes: Read this again");
  });

  it("refreshes content that Reddit owns rather than keeping the old body", () => {
    const selfProvider = mapRedditSave(
      post({ is_self: true, selftext: "Edited body" }),
    );
    const merged = mergeRedditProviderItem(
      {
        url: selfProvider.url,
        normalized_url: selfProvider.normalized_url,
        title: null,
        description: null,
        notes: null,
        content: "Original body",
        author: null,
        thumbnail_url: null,
        tags: [],
        metadata: {},
      },
      selfProvider,
    );

    expect(merged.content).toBe("Edited body");
  });

  it("keeps an existing thumbnail when Reddit stops sending one", () => {
    const merged = mergeRedditProviderItem(
      {
        url: provider.url,
        normalized_url: provider.normalized_url,
        title: null,
        description: null,
        notes: null,
        content: null,
        author: null,
        thumbnail_url: "https://b.thumbs.redditmedia.com/kept.jpg",
        tags: [],
        metadata: {},
      },
      provider,
    );

    expect(merged.thumbnail_url).toBe(
      "https://b.thumbs.redditmedia.com/kept.jpg",
    );
  });
});
