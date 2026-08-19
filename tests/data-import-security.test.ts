import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { ImportAnalysisError, analyzeExport } from "@/lib/data-import/analyze";
import { ImportFileError, readImportArchive } from "@/lib/data-import/archive";
import {
  isPrivacyExcluded,
  PRIVACY_EXCLUDED_STEMS,
} from "@/lib/data-import/datasets";
import {
  IMPORT_LIMITS,
  rejectImportEntryPath,
  rejectImportEntrySize,
} from "@/lib/data-import/limits";
import { normalizeLinkedInRow } from "@/lib/data-import/linkedin/parse";
import { normalizeRedditRow } from "@/lib/data-import/reddit/parse";
import { importRecordSchema } from "@/lib/data-import/schemas";

import { buildZip, csv, redditSavedPosts } from "./data-import-fixtures";

describe("archive entry paths", () => {
  it("rejects traversal, absolute and Windows-style paths", () => {
    expect(rejectImportEntryPath("../escape.csv")).toBe("path_traversal");
    expect(rejectImportEntryPath("data/../../escape.csv")).toBe(
      "path_traversal",
    );
    // A backslash separator must not bypass the forward-slash check.
    expect(rejectImportEntryPath("data\\..\\..\\escape.csv")).toBe(
      "path_traversal",
    );
    expect(rejectImportEntryPath("/etc/passwd")).toBe("absolute_path");
    expect(rejectImportEntryPath("C:/Windows/system32")).toBe("absolute_path");
  });

  it("rejects absurd depth and length", () => {
    expect(rejectImportEntryPath("a/".repeat(40) + "f.csv")).toBe(
      "path_too_deep",
    );
    expect(rejectImportEntryPath("x".repeat(600))).toBe("path_too_long");
  });

  it("accepts ordinary export paths", () => {
    expect(rejectImportEntryPath("saved_posts.csv")).toBeNull();
    expect(
      rejectImportEntryPath("Basic_LinkedInDataExport/Saved_Items.csv"),
    ).toBeNull();
  });
});

describe("archive entry sizes", () => {
  it("rejects an entry that expands implausibly", () => {
    expect(rejectImportEntrySize(2_000, 2_000 * 500)).toBe("compression_ratio");
  });

  it("ignores the ratio for tiny files", () => {
    expect(rejectImportEntrySize(10, 5_000)).toBeNull();
  });

  it("rejects an oversized entry", () => {
    expect(
      rejectImportEntrySize(1_000_000, IMPORT_LIMITS.maxEntryBytes + 1),
    ).toBe("entry_too_large");
  });
});

describe("readImportArchive", () => {
  it("skips a traversal entry but still reads the safe ones", async () => {
    const archive = buildZip({
      "../../etc/passwd": "root:x:0:0",
      "saved_posts.csv": redditSavedPosts(),
    });
    const result = await readImportArchive("export.zip", archive);

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "saved_posts.csv",
    ]);
    expect(result.skipped.some((file) => file.status === "skipped")).toBe(true);
  });

  it("never opens a nested archive", async () => {
    const inner = zipSync({ "deep.csv": strToU8("a,b\n1,2") });
    const archive = buildZip({ "saved_posts.csv": redditSavedPosts() });
    const withNested = zipSync({
      "saved_posts.csv": strToU8(redditSavedPosts()),
      "bomb.zip": inner,
    });
    void archive;

    const result = await readImportArchive("export.zip", withNested);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "saved_posts.csv",
    ]);
    expect(
      result.skipped.some(
        (file) => file.message === "Skipped a nested archive.",
      ),
    ).toBe(true);
  });

  it("refuses to decompress a bomb-shaped entry at all", async () => {
    // Highly compressible payload: a small archive claiming a huge expansion.
    const bomb = zipSync({
      "saved_posts.csv": strToU8("A".repeat(40 * 1024 * 1024)),
    });
    const result = await readImportArchive("export.zip", bomb).catch(
      (error: unknown) => error,
    );

    if (result instanceof ImportFileError) {
      expect(result.message).toMatch(/couldn't recognize|exceeds the safe/);
    } else {
      // Or it was skipped by ratio, and nothing usable came out.
      expect((result as { entries: unknown[] }).entries).toHaveLength(0);
    }
  });

  it("never decodes an executable or any non-text entry", async () => {
    const archive = buildZip({
      "saved_posts.csv": redditSavedPosts(),
      "installer.exe": "MZ\u0000\u0000EXECUTABLE",
      "macro.xlsm": "binary",
      "script.js": "window.evil = 1",
    });
    const result = await readImportArchive("export.zip", archive);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "saved_posts.csv",
    ]);
  });

  it("rejects a corrupt ZIP with a friendly message", async () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    await expect(readImportArchive("export.zip", corrupt)).rejects.toThrow(
      /couldn't be read/i,
    );
  });

  it("rejects an archive above the whole-file ceiling", async () => {
    const oversized = new Uint8Array(IMPORT_LIMITS.maxArchiveBytes + 1);
    oversized.set([0x50, 0x4b, 0x03, 0x04]);
    await expect(readImportArchive("export.zip", oversized)).rejects.toThrow(
      /exceeds the safe import size/i,
    );
  });

  it("rejects an unrelated file type outright", async () => {
    await expect(
      readImportArchive(
        "holiday.jpg",
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      ),
    ).rejects.toThrow(/couldn't recognize/i);
  });
});

describe("platform detection refuses to guess", () => {
  it("rejects an arbitrary ZIP that happens to contain a comments file", async () => {
    // One matching filename is not an export. This is the case that would
    // otherwise let any ZIP be claimed as a platform download.
    const archive = buildZip({
      "comments.csv": csv(["author", "text"], [["me", "hello"]]),
      "readme.txt": "notes",
    });
    await expect(analyzeExport("stuff.zip", archive)).rejects.toThrow(
      /couldn't recognize/i,
    );
  });

  it("asks the user when an archive scores equally for both platforms", async () => {
    // One distinctive filename per platform and nothing else to break the
    // tie: no recognisable column shapes, no platform URLs in the content.
    const archive = buildZip({
      "multireddits.csv": csv(["name", "description"], [["mine", "notes"]]),
      "Saved_Jobs.csv": csv(["alpha", "beta"], [["one", "two"]]),
    });

    const error = await analyzeExport("mixed.zip", archive).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ImportAnalysisError);
    expect((error as ImportAnalysisError).candidates).toEqual([
      "reddit",
      "linkedin",
    ]);
  });

  it("lets the user's choice settle an ambiguous archive", async () => {
    const archive = buildZip({
      "multireddits.csv": csv(["name", "description"], [["mine", "notes"]]),
      "Saved_Jobs.csv": csv(["alpha", "beta"], [["one", "two"]]),
      "saved_posts.csv": redditSavedPosts(),
    });

    const result = await analyzeExport("mixed.zip", archive, "reddit");
    expect(result.platform).toBe("reddit");
  });

  it("reports an export with no supported datasets clearly", async () => {
    const archive = buildZip({
      "subscribed_subreddits.csv": csv(["subreddit"], [["a"]]),
      "multireddits.csv": csv(["name"], [["b"]]),
      "messages.csv": csv(["id", "body"], [["1", "PRIVATE"]]),
    });
    await expect(analyzeExport("reddit.zip", archive)).rejects.toThrow(
      /doesn't contain any supported saved or activity data/i,
    );
  });
});

describe("privacy allowlist", () => {
  it("names every excluded dataset as excluded", () => {
    for (const stem of PRIVACY_EXCLUDED_STEMS) {
      expect(isPrivacyExcluded(`${stem}.csv`)).toBe(true);
      expect(isPrivacyExcluded(`export/${stem.toUpperCase()}.CSV`)).toBe(true);
    }
  });

  it("does not exclude the datasets we do import", () => {
    expect(isPrivacyExcluded("saved_posts.csv")).toBe(false);
    expect(isPrivacyExcluded("Saved_Items.csv")).toBe(false);
    expect(isPrivacyExcluded("Shares.csv")).toBe(false);
  });
});

describe("URL safety", () => {
  it("refuses dangerous schemes in every URL column", () => {
    for (const dangerous of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
    ]) {
      expect(
        normalizeLinkedInRow(
          { savedItem: dangerous, saveditem: dangerous },
          "linkedin_saved_item",
          "Saved_Items.csv",
        ),
      ).toBeNull();
      expect(
        normalizeRedditRow(
          { permalink: dangerous, id: "" },
          "reddit_saved_post",
          "saved_posts.csv",
        ),
      ).toBeNull();
    }
  });

  it("refuses a permalink pointing at a look-alike host", () => {
    const evil = "https://reddit.com.evil.example/r/x/comments/abc123/t";
    expect(
      normalizeRedditRow(
        { permalink: evil },
        "reddit_saved_post",
        "saved_posts.csv",
      ),
    ).toBeNull();
  });

  it("never lets an external URL escape into the canonical URL", () => {
    const record = normalizeRedditRow(
      {
        permalink: "https://www.reddit.com/r/x/comments/abc123/t/",
        url: "https://example.com/target",
      },
      "reddit_saved_post",
      "saved_posts.csv",
    )!;
    expect(record.canonicalUrl.startsWith("https://www.reddit.com/")).toBe(
      true,
    );
    expect(record.externalUrl).toBe("https://example.com/target");
  });
});

describe("wire schema", () => {
  const valid = {
    platform: "reddit" as const,
    contentKey: "reddit:t3_abc123",
    contentType: "post" as const,
    canonicalUrl: "https://www.reddit.com/r/x/comments/abc123/t",
    categories: ["reddit_saved_post"],
  };

  it("accepts a well-formed record", () => {
    expect(importRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a canonical URL that is not Reddit or LinkedIn", () => {
    for (const url of [
      "https://evil.example.com/x",
      "http://www.reddit.com/r/x/comments/abc/t",
      "javascript:alert(1)",
      "https://reddit.com.evil.example/x",
    ]) {
      expect(
        importRecordSchema.safeParse({ ...valid, canonicalUrl: url }).success,
      ).toBe(false);
    }
  });

  it("refuses text fields far beyond their cap", () => {
    expect(
      importRecordSchema.safeParse({ ...valid, rawText: "x".repeat(20_000) })
        .success,
    ).toBe(false);
    expect(
      importRecordSchema.safeParse({ ...valid, contentKey: "x".repeat(500) })
        .success,
    ).toBe(false);
  });

  it("refuses a record naming no category", () => {
    expect(
      importRecordSchema.safeParse({ ...valid, categories: [] }).success,
    ).toBe(false);
  });

  it("does not accept a client-supplied user id, item id or content availability", () => {
    const parsed = importRecordSchema.parse({
      ...valid,
      user_id: "11111111-1111-4111-8111-111111111111",
      savedItemId: "22222222-2222-4222-8222-222222222222",
      contentAvailability: "full",
    });
    // Unknown keys are dropped: identity and cost decisions are the server's.
    expect(parsed).not.toHaveProperty("user_id");
    expect(parsed).not.toHaveProperty("savedItemId");
    expect(parsed).not.toHaveProperty("contentAvailability");
  });
});

describe("untrusted text is stored as text", () => {
  it("keeps markup as inert characters rather than interpreting it", () => {
    const malicious = '<img src=x onerror="alert(1)"> <script>evil()</script>';
    const record = normalizeLinkedInRow(
      {
        shareLink:
          "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000001",
        sharelink:
          "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000001",
        shareCommentary: malicious,
        sharecommentary: malicious,
      },
      "linkedin_share",
      "Shares.csv",
    )!;
    // Stored verbatim as data; React escapes it at render time and nothing in
    // this codebase renders imported content as HTML.
    expect(record.rawText).toBe(malicious);
  });
});
