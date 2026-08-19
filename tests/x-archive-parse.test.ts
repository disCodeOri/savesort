import { describe, expect, it, vi } from "vitest";

import {
  detectDataset,
  detectDatasetFromShape,
  isPrivacyExcluded,
} from "@/lib/x-archive/datasets";
import {
  detectFormat,
  parseArchiveFile,
  stripJsAssignment,
} from "@/lib/x-archive/parse-file";

describe("stripJsAssignment", () => {
  it("removes the wrapper X uses today", () => {
    const source = 'window.YTD.like.part0 = [{"like":{"tweetId":"123"}}]';
    expect(JSON.parse(stripJsAssignment(source))).toEqual([
      { like: { tweetId: "123" } },
    ]);
  });

  it("removes a differently named wrapper", () => {
    // X has renamed this prefix before; matching is structural, not literal.
    const source = 'someOther.dataset.part12 = [{"a":1}]';
    expect(JSON.parse(stripJsAssignment(source))).toEqual([{ a: 1 }]);
  });

  it("handles bracket notation and a trailing semicolon", () => {
    const source = 'window["YTD"].tweets.part0 = [{"b":2}];';
    expect(JSON.parse(stripJsAssignment(source))).toEqual([{ b: 2 }]);
  });

  it("strips a byte order mark and leading whitespace", () => {
    const source = '﻿  window.YTD.bookmark.part0 = [{"c":3}]';
    expect(JSON.parse(stripJsAssignment(source))).toEqual([{ c: 3 }]);
  });

  it("leaves bare JSON untouched", () => {
    expect(JSON.parse(stripJsAssignment('[{"d":4}]'))).toEqual([{ d: 4 }]);
  });
});

describe("parseArchiveFile", () => {
  it("never executes JavaScript found in an archive", () => {
    // If this file were evaluated, the global would be set. It must not be.
    const marker = vi.fn();
    (globalThis as Record<string, unknown>).__archivePwned = marker;
    const malicious =
      'window.YTD.like.part0 = (globalThis.__archivePwned(), [{"like":{"tweetId":"1"}}])';

    const result = parseArchiveFile("data/like.js", malicious);

    expect(marker).not.toHaveBeenCalled();
    // It is not valid JSON either, so it is reported rather than run.
    expect(result.records).toEqual([]);
    expect(result.error).toBeTruthy();
    delete (globalThis as Record<string, unknown>).__archivePwned;
  });

  it("reports a parse failure without echoing file contents", () => {
    const secret = "SECRET-TOKEN-abc123";
    const result = parseArchiveFile("data/like.js", `garbage ${secret}`);

    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(secret);
  });

  it("parses a JSON archive file", () => {
    const result = parseArchiveFile(
      "data/likes.json",
      '[{"like":{"tweetId":"9"}}]',
    );
    expect(result.format).toBe("json");
    expect(result.records).toHaveLength(1);
  });

  it("wraps a single top-level object as one record", () => {
    const result = parseArchiveFile(
      "data/account.js",
      'x.y = {"account":{"username":"a"}}',
    );
    expect(result.records).toHaveLength(1);
  });

  it("parses CSV with quoted fields containing commas", () => {
    const csv = 'tweetId,text\n"123","hello, world"\n';
    const result = parseArchiveFile("data/notes.csv", csv);
    expect(result.records).toEqual([{ tweetId: "123", text: "hello, world" }]);
  });

  it("treats an empty file as an error rather than data", () => {
    expect(parseArchiveFile("data/like.js", "   ").error).toBeTruthy();
  });

  it("detects formats from the extension", () => {
    expect(detectFormat("a/b.js")).toBe("js");
    expect(detectFormat("a/b.JSON")).toBe("json");
    expect(detectFormat("a/b.csv")).toBe("csv");
    expect(detectFormat("a/b.bin")).toBe("unknown");
  });
});

describe("privacy allowlist", () => {
  it("excludes direct messages and other sensitive datasets", () => {
    for (const path of [
      "data/direct-messages.js",
      "data/direct_message_headers.js",
      "data/dm-conversations.js",
      "data/contact.js",
      "data/address-book.js",
      "data/ip-audit.js",
      "data/device-token.js",
      "data/login-ip-address.js",
      "data/ad-impressions.js",
      "data/personalization.js",
      "data/payment-info.js",
    ]) {
      expect(isPrivacyExcluded(path)).toBe(true);
      expect(detectDataset(path)).toBeNull();
    }
  });

  it("does not classify an unknown dataset as content", () => {
    // Anything unrecognised is skipped, so a future X dataset is excluded by
    // default rather than silently ingested.
    expect(detectDataset("data/some-new-thing.js")).toBeNull();
  });
});

describe("detectDataset", () => {
  it("recognises old Twitter and new X naming", () => {
    expect(detectDataset("data/tweets.js")?.dataset).toBe("posts");
    expect(detectDataset("data/tweet.js")?.dataset).toBe("posts");
    expect(detectDataset("data/posts.js")?.dataset).toBe("posts");
    expect(detectDataset("data/like.js")?.dataset).toBe("likes");
    expect(detectDataset("data/likes.json")?.dataset).toBe("likes");
    expect(detectDataset("data/bookmarks.js")?.dataset).toBe("bookmarks");
  });

  it("handles multi-part dataset files", () => {
    expect(detectDataset("data/tweets-part1.js")?.dataset).toBe("posts");
    expect(detectDataset("data/like-part12.js")?.dataset).toBe("likes");
  });

  it("ignores directory nesting and a twitter- prefix", () => {
    expect(detectDataset("archive/data/twitter-likes.js")?.dataset).toBe(
      "likes",
    );
  });

  it("falls back to record shape for an unfamiliar filename", () => {
    const records = [
      { like: { tweetId: "1", expandedUrl: "https://x.com/a/status/1" } },
    ];
    expect(detectDatasetFromShape("data/renamed.js", records)?.dataset).toBe(
      "likes",
    );
  });

  it("refuses shape detection for an excluded path", () => {
    // Shape matching must never re-admit something the allowlist rejected.
    const records = [{ like: { tweetId: "1" } }];
    expect(
      detectDatasetFromShape("data/direct-messages.js", records),
    ).toBeNull();
  });

  it("returns null for shapes it does not recognise", () => {
    expect(
      detectDatasetFromShape("data/x.js", [{ unrelated: { a: 1 } }]),
    ).toBeNull();
    expect(detectDatasetFromShape("data/x.js", [])).toBeNull();
  });
});
