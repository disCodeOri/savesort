import { describe, expect, it } from "vitest";

import { analyzeExport } from "@/lib/data-import/analyze";
import { parseCsv } from "@/lib/data-import/csv";
import {
  normalizeRedditRow,
  parseRedditTable,
} from "@/lib/data-import/reddit/parse";
import {
  parseRedditPermalink,
  redditContentKey,
  stripThingPrefix,
  titleFromSlug,
} from "@/lib/data-import/reddit/urls";
import { mapRedditSave } from "@/lib/reddit/map-save";
import type { RedditSavedPost } from "@/lib/reddit/types";

import {
  buildZip,
  csv,
  LONG_BODY,
  redditArchive,
  redditOwnComments,
  redditOwnPosts,
  redditSavedComments,
  redditSavedPosts,
  REDDIT_COMMENT_PERMALINK,
  REDDIT_POST_PERMALINK,
} from "./data-import-fixtures";

function firstRow(source: string) {
  return parseCsv(source).rows[0]!;
}

describe("Reddit permalink parsing", () => {
  it("splits a post permalink into its parts", () => {
    const parts = parseRedditPermalink(REDDIT_POST_PERMALINK);
    expect(parts).toEqual({
      subreddit: "localfirst",
      postId: "abc123",
      slug: "why_crdts_beat_operational_transforms",
      commentId: null,
    });
  });

  it("splits a comment permalink and keeps the parent post id", () => {
    const parts = parseRedditPermalink(REDDIT_COMMENT_PERMALINK);
    expect(parts.postId).toBe("abc123");
    expect(parts.commentId).toBe("def456");
  });

  it("accepts a bare path and old.reddit.com", () => {
    expect(parseRedditPermalink("/r/x/comments/abc123/t/").postId).toBe(
      "abc123",
    );
    expect(
      parseRedditPermalink("https://old.reddit.com/r/x/comments/abc123/t/")
        .postId,
    ).toBe("abc123");
  });

  it("refuses anything that does not resolve to Reddit", () => {
    expect(
      parseRedditPermalink("https://evil.example.com/r/x/comments/abc/t")
        .postId,
    ).toBeNull();
    expect(parseRedditPermalink("javascript:alert(1)").postId).toBeNull();
    expect(parseRedditPermalink("").postId).toBeNull();
  });

  it("ignores a t3_/t1_ prefix when comparing ids", () => {
    expect(stripThingPrefix("t3_abc123")).toBe("abc123");
    expect(stripThingPrefix("t1_def456")).toBe("def456");
    expect(stripThingPrefix("abc123")).toBe("abc123");
  });

  it("recovers readable words from the permalink slug", () => {
    expect(titleFromSlug("why_crdts_beat_operational_transforms")).toBe(
      "Why crdts beat operational transforms",
    );
    // A slug with no letters carries no information worth showing.
    expect(titleFromSlug("12345")).toBeNull();
    expect(titleFromSlug(null)).toBeNull();
  });
});

describe("Reddit identity", () => {
  it("keys posts and comments distinctly", () => {
    expect(redditContentKey({ postId: "abc123" })).toBe("reddit:t3_abc123");
    expect(redditContentKey({ postId: "abc123", commentId: "def456" })).toBe(
      "reddit:t1_def456:abc123",
    );
  });

  it("produces the same canonical URL as the Reddit OAuth sync", () => {
    // This is what makes an export converge with the connected account rather
    // than duplicating every post.
    const post: RedditSavedPost = {
      id: "abc123",
      name: "t3_abc123",
      permalink:
        "/r/localfirst/comments/abc123/why_crdts_beat_operational_transforms/",
      title: "Why CRDTs beat operational transforms",
      subreddit: "localfirst",
      subreddit_name_prefixed: "r/localfirst",
      author: "someone",
      url: null,
      selftext: LONG_BODY,
      link_flair_text: null,
      thumbnail: null,
      score: 10,
      num_comments: 2,
      created_utc: 1_741_000_000,
      over_18: false,
      is_self: true,
    };

    const fromOauth = mapRedditSave(post).normalized_url;
    const fromExport = normalizeRedditRow(
      firstRow(redditSavedPosts()),
      "reddit_saved_post",
      "saved_posts.csv",
    )!.canonicalUrl;

    expect(fromExport).toBe(fromOauth);
  });
});

describe("Reddit row normalization", () => {
  it("imports a saved post that has only an id and a permalink", () => {
    const record = normalizeRedditRow(
      firstRow(redditSavedPosts()),
      "reddit_saved_post",
      "saved_posts.csv",
    )!;

    expect(record.contentKey).toBe("reddit:t3_abc123");
    expect(record.sourceId).toBe("t3_abc123");
    expect(record.community).toBe("localfirst");
    // The slug is decoded from the permalink, and says so.
    expect(record.titleSource).toBe("permalink_slug");
    // No body was supplied, and none is invented.
    expect(record.rawText).toBeNull();
    // Reddit's export dates no save, so the field stays empty.
    expect(record.sourceSavedAt).toBeNull();
  });

  it("imports a saved comment as its own item", () => {
    const record = normalizeRedditRow(
      firstRow(redditSavedComments()),
      "reddit_saved_comment",
      "saved_comments.csv",
    )!;

    expect(record.contentType).toBe("comment");
    expect(record.contentKey).toBe("reddit:t1_def456:abc123");
    expect(record.parentContentKey).toBe("reddit:t3_abc123");
    // A comment has no title of its own; the parent post's slug is not one.
    expect(record.title).toBeNull();
    expect(record.rawText).toBeNull();
  });

  it("reads title, body and dates from the user's own posts", () => {
    const record = normalizeRedditRow(
      firstRow(redditOwnPosts()),
      "reddit_own_post",
      "posts.csv",
    )!;

    expect(record.titleSource).toBe("source");
    expect(record.title).toBe("Why CRDTs beat operational transforms");
    expect(record.rawText).toBe(LONG_BODY);
    expect(record.sourceCreatedAt).toBe("2025-03-04T11:22:33.000Z");
    // A self-post's `url` column repeats the permalink; that is not external.
    expect(record.externalUrl).toBeNull();
  });

  it("falls back to the id column when the permalink is unusable", () => {
    // `reddit.com/comments/<id>` is a real Reddit permalink shape, so building
    // it from an id the export supplied recovers the item rather than
    // inventing a destination.
    const record = normalizeRedditRow(
      firstRow(csv(["id", "permalink"], [["abc123", "not-a-url"]])),
      "reddit_saved_post",
      "saved_posts.csv",
    )!;
    expect(record.canonicalUrl).toBe("https://www.reddit.com/comments/abc123");
    expect(record.contentKey).toBe("reddit:t3_abc123");
    expect(record.community).toBeNull();
  });

  it("returns null when neither an id nor a permalink identifies anything", () => {
    const row = firstRow(
      csv(["id", "permalink"], [["not-an-id!", "not-a-url"]]),
    );
    expect(
      normalizeRedditRow(row, "reddit_saved_post", "saved_posts.csv"),
    ).toBeNull();
  });

  it("never guesses a comment id it was not given", () => {
    // A saved comment whose permalink stops at the post, with no id column,
    // cannot be identified as a comment and must not be filed as one.
    const row = firstRow(csv(["permalink"], [[REDDIT_POST_PERMALINK]]));
    expect(
      normalizeRedditRow(row, "reddit_saved_comment", "saved_comments.csv"),
    ).toBeNull();
  });

  it("keeps only upvotes from the votes file", () => {
    const table = parseCsv(
      csv(
        ["id", "permalink", "direction"],
        [
          ["abc123", REDDIT_POST_PERMALINK, "up"],
          [
            "zzz999",
            "https://www.reddit.com/r/other/comments/zzz999/thing/",
            "down",
          ],
        ],
      ),
    );
    const parsed = parseRedditTable(
      table,
      "reddit_upvoted_post",
      "post_votes.csv",
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]!.contentKey).toBe("reddit:t3_abc123");
  });

  it("counts an unidentifiable row as unresolved instead of guessing a URL", () => {
    const table = parseCsv(
      // A wholly blank line is not a record and never reaches the parser, so
      // both of these carry content that simply does not identify anything.
      csv(
        ["id", "permalink"],
        [
          ["not-an-id!", "https://evil.example.com/x"],
          ["also bad", "javascript:alert(1)"],
        ],
      ),
    );
    const parsed = parseRedditTable(
      table,
      "reddit_saved_post",
      "saved_posts.csv",
    );
    expect(parsed.records).toHaveLength(0);
    expect(parsed.unresolved).toBe(2);
  });

  it("tolerates reordered columns, extra columns and a BOM", () => {
    const table = parseCsv(
      `﻿extra,permalink,id\nnoise,${REDDIT_POST_PERMALINK},abc123`,
    );
    const parsed = parseRedditTable(
      table,
      "reddit_saved_post",
      "saved_posts.csv",
    );
    expect(parsed.records).toHaveLength(1);
  });
});

describe("Reddit archive analysis", () => {
  it("detects Reddit and reports only the categories present", async () => {
    const result = await analyzeExport("reddit_export.zip", redditArchive());

    expect(result.platform).toBe("reddit");
    const categories = result.datasets
      .map((dataset) => dataset.category)
      .sort();
    expect(categories).toEqual([
      "reddit_saved_comment",
      "reddit_saved_post",
      "reddit_upvoted_post",
    ]);
    // Saved content is pre-selected; upvotes are opt-in.
    expect(result.defaultSelection.sort()).toEqual([
      "reddit_saved_comment",
      "reddit_saved_post",
    ]);
  });

  it("never opens messages, chat history, IP logs or linked identities", async () => {
    const result = await analyzeExport("reddit_export.zip", redditArchive());
    const opened = result.files
      .filter((file) => file.status === "parsed")
      .map((file) => file.path);

    expect(opened).not.toContain("messages.csv");
    expect(opened).not.toContain("chat_history.csv");
    expect(opened).not.toContain("ip_logs.csv");
    expect(opened).not.toContain("linked_identities.csv");
    expect(JSON.stringify(result.records)).not.toContain("PRIVATE");
  });

  it("reads a standalone saved_posts.csv with no ZIP around it", async () => {
    const result = await analyzeExport(
      "saved_posts.csv",
      new TextEncoder().encode(redditSavedPosts()),
    );
    expect(result.platform).toBe("reddit");
    expect(result.records).toHaveLength(1);
  });

  it("survives a renamed file by falling back to column shape", async () => {
    const archive = buildZip({
      "reddit/export/Saved_Posts (1).CSV": redditSavedPosts(),
      "reddit/export/post_votes.csv": redditArchiveVotes(),
      "reddit/export/subscribed_subreddits.csv": csv(
        ["subreddit"],
        [["localfirst"]],
      ),
    });
    const result = await analyzeExport("reddit_export.zip", archive);
    expect(result.platform).toBe("reddit");
    expect(
      result.datasets.some(
        (dataset) => dataset.category === "reddit_saved_post",
      ),
    ).toBe(true);
  });

  it("ignores an empty dataset and unknown files without failing", async () => {
    const archive = redditArchive({
      "saved_comments.csv": "id,permalink\n",
      "brand_new_dataset.csv": csv(["a", "b"], [["1", "2"]]),
    });
    const result = await analyzeExport("reddit_export.zip", archive);
    expect(result.platform).toBe("reddit");
    expect(
      result.datasets.find(
        (dataset) => dataset.category === "reddit_saved_comment",
      ),
    ).toBeUndefined();
  });

  it("merges a saved post with the user's own post and comment from the same export", async () => {
    const archive = redditArchive({
      "posts.csv": redditOwnPosts(),
      "comments.csv": redditOwnComments(),
    });
    const result = await analyzeExport("reddit_export.zip", archive);

    const saved = result.records.filter(
      (record) => record.category === "reddit_saved_post",
    );
    const own = result.records.filter(
      (record) => record.category === "reddit_own_post",
    );
    expect(saved[0]!.contentKey).toBe(own[0]!.contentKey);
  });
});

function redditArchiveVotes(): string {
  return csv(
    ["id", "permalink", "direction"],
    [["abc123", REDDIT_POST_PERMALINK, "up"]],
  );
}
