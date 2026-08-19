import { describe, expect, it } from "vitest";

import { analyzeExport } from "@/lib/data-import/analyze";
import {
  parseGenericJson,
  toSyntheticRow,
} from "@/lib/data-import/generic-parse";
import { toGenericRecord } from "@/lib/data-import/json-records";

import {
  buildZip,
  csv,
  LONG_BODY,
  redditSavedPosts,
} from "./data-import-fixtures";

/**
 * The recovery path: an export file whose layout nobody wrote a parser for.
 *
 * The point of these tests is that recovery does not get its own identity
 * rules. A record rescued from an unknown JSON layout must land on exactly the
 * same `saved_items` row as the same record arriving through a recognised CSV.
 */

describe("toSyntheticRow", () => {
  it("presents a generic record in the shape the normalizers read", () => {
    const record = toGenericRecord({
      link: "https://www.reddit.com/r/rust/comments/abc123/why_async_is_hard/",
      title: "Why async is hard",
      body: LONG_BODY,
      author: "someone",
      subreddit: "rust",
    })!;

    const row = toSyntheticRow(record);
    expect(row.permalink).toContain("/comments/abc123/");
    expect(row.title).toBe("Why async is hard");
    expect(row.body).toBe(LONG_BODY);
  });

  it("never passes a slug-decoded title off as a title column", () => {
    // Otherwise the normalizer would stamp it `titleSource: "source"`, which
    // would claim the platform wrote words we decoded from a URL.
    const record = toGenericRecord({
      link: "https://www.reddit.com/r/rust/comments/abc123/why_async_is_hard/",
    })!;

    expect(record.titleFromUrl).toBe(true);
    expect(toSyntheticRow(record).title).toBeUndefined();
  });
});

describe("parseGenericJson", () => {
  it("recovers Reddit saves from a layout with no recognised columns", () => {
    const text = JSON.stringify({
      schemaVersion: 9,
      savedThings: [
        {
          thingRef:
            "https://www.reddit.com/r/rust/comments/abc123/why_async_is_hard/",
          when: "2025-05-12 09:31:04 UTC",
        },
      ],
    });

    const result = parseGenericJson("reddit", text, "unknown.json");
    expect(result.records).toHaveLength(1);

    const record = result.records[0]!;
    expect(record.contentKey).toBe("reddit:t3_abc123");
    expect(record.community).toBe("rust");
    // The slug is recovered, and labelled as coming from the permalink.
    expect(record.title).toBe("Why async is hard");
    expect(record.titleSource).toBe("permalink_slug");
  });

  it("gives a recovered record the same identity as a recognised one", () => {
    const text = JSON.stringify([
      {
        somethingUnexpected:
          "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_operational_transforms/",
      },
    ]);

    const recovered = parseGenericJson("reddit", text, "unknown.json")
      .records[0]!;
    const [known] = parseGenericJson(
      "reddit",
      JSON.stringify([
        {
          permalink:
            "https://www.reddit.com/r/localfirst/comments/abc123/why_crdts_beat_operational_transforms/",
        },
      ]),
      "known.json",
    ).records;

    expect(recovered.contentKey).toBe(known!.contentKey);
    expect(recovered.canonicalUrl).toBe(known!.canonicalUrl);
  });

  it("recovers LinkedIn saves and keeps the activity id", () => {
    const text = JSON.stringify([
      {
        item: "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/",
        bookmarkedOn: "2025-05-12",
      },
    ]);

    const record = parseGenericJson("linkedin", text, "unknown.json")
      .records[0]!;
    expect(record.sourceId).toBe("7100000000000000001");
    expect(record.sourceSavedAt).toBe("2025-05-12T00:00:00.000Z");
  });

  it("counts an off-platform record as unresolved rather than guessing", () => {
    const text = JSON.stringify([
      { link: "https://example.com/not-reddit" },
      { link: "https://www.reddit.com/r/rust/comments/abc123/t/" },
    ]);

    const result = parseGenericJson("reddit", text, "unknown.json");
    expect(result.records).toHaveLength(1);
    expect(result.unresolved).toBe(1);
  });

  it("refuses private fields even in an unknown layout", () => {
    const text = JSON.stringify([
      {
        link: "https://www.reddit.com/r/rust/comments/abc123/t/",
        submitterEmail: "private@example.com",
        clientIp: "203.0.113.9",
      },
    ]);

    const result = parseGenericJson("reddit", text, "unknown.json");
    expect(JSON.stringify(result.records)).not.toContain("private@example.com");
    expect(JSON.stringify(result.records)).not.toContain("203.0.113.9");
    expect(result.droppedPrivateKeys.length).toBeGreaterThan(0);
  });

  it("returns nothing rather than throwing on malformed JSON", () => {
    expect(
      parseGenericJson("reddit", "{oops", "bad.json").records,
    ).toHaveLength(0);
  });
});

describe("recovery inside a real export", () => {
  it("reads an unrecognised JSON dataset that sits beside recognised CSVs", async () => {
    const archive = buildZip({
      "saved_posts.csv": redditSavedPosts(),
      "post_votes.csv": csv(
        ["id", "permalink", "direction"],
        [
          [
            "abc123",
            "https://www.reddit.com/r/localfirst/comments/abc123/t/",
            "up",
          ],
        ],
      ),
      "subscribed_subreddits.csv": csv(["subreddit"], [["localfirst"]]),
      // A layout no rule knows about.
      "saved_v2.json": JSON.stringify({
        items: [
          {
            ref: "https://www.reddit.com/r/rust/comments/zzz999/why_async_is_hard/",
            when: "2025-05-12 09:31:04 UTC",
          },
        ],
      }),
    });

    const result = await analyzeExport("reddit_export.zip", archive);

    expect(result.platform).toBe("reddit");
    // The unknown file contributed a record rather than being skipped.
    expect(
      result.records.some((record) => record.contentKey === "reddit:t3_zzz999"),
    ).toBe(true);
    expect(
      result.files.some(
        (file) => file.message === "Read from an unrecognised file layout.",
      ),
    ).toBe(true);
  });

  it("still ignores an unknown file that yields nothing usable", async () => {
    const archive = buildZip({
      "saved_posts.csv": redditSavedPosts(),
      "subscribed_subreddits.csv": csv(["subreddit"], [["localfirst"]]),
      "settings.json": JSON.stringify({ theme: "dark", pageSize: 25 }),
    });

    const result = await analyzeExport("reddit_export.zip", archive);
    expect(result.files.some((file) => file.path === "settings.json")).toBe(
      false,
    );
  });
});
