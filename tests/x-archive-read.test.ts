import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_LIMITS,
  rejectEntryPath,
  rejectEntrySize,
} from "@/lib/x-archive/limits";
import { ArchiveReadError, readXArchive } from "@/lib/x-archive/read-archive";

const LONG_TEXT =
  "A detailed thread about why most AI agent architectures do not need a vector database at all.";

/** Builds a synthetic archive. No real personal data is ever committed. */
function buildArchive(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, contents] of Object.entries(files)) {
    entries[path] = strToU8(contents);
  }
  return zipSync(entries);
}

function jsDataset(name: string, payload: unknown): string {
  return `window.YTD.${name}.part0 = ${JSON.stringify(payload)}`;
}

describe("entry path validation", () => {
  it("rejects traversal and absolute paths", () => {
    expect(rejectEntryPath("../escape.js")).toBe("path_traversal");
    expect(rejectEntryPath("data/../../escape.js")).toBe("path_traversal");
    // Windows-style separators must not bypass the check.
    expect(rejectEntryPath("data\\..\\..\\escape.js")).toBe("path_traversal");
    expect(rejectEntryPath("/etc/passwd")).toBe("absolute_path");
    expect(rejectEntryPath("C:/Windows/system32")).toBe("absolute_path");
  });

  it("rejects absurd depth and length", () => {
    expect(rejectEntryPath("a/".repeat(40) + "f.js")).toBe("path_too_deep");
    expect(rejectEntryPath("x".repeat(600))).toBe("path_too_long");
  });

  it("accepts ordinary archive paths", () => {
    expect(rejectEntryPath("data/like.js")).toBeNull();
    expect(rejectEntryPath("data/tweets-part1.js")).toBeNull();
  });
});

describe("entry size validation", () => {
  it("rejects an entry that expands implausibly", () => {
    // Classic decompression bomb signature.
    expect(rejectEntrySize(2_000, 2_000 * 500)).toBe("compression_ratio");
  });

  it("ignores the ratio for tiny files", () => {
    expect(rejectEntrySize(10, 5_000)).toBeNull();
  });

  it("rejects an oversized entry", () => {
    expect(rejectEntrySize(1_000_000, ARCHIVE_LIMITS.maxEntryBytes + 1)).toBe(
      "entry_too_large",
    );
  });
});

describe("readXArchive", () => {
  it("reads likes, bookmarks and posts from a JS-wrapped archive", async () => {
    const archive = buildArchive({
      "data/like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
      "data/bookmarks.js": jsDataset("bookmark", [
        { bookmark: { tweetId: "1900000000000000002" } },
      ]),
      "data/tweets.js": jsDataset("tweets", [
        { tweet: { id_str: "1900000000000000003", full_text: LONG_TEXT } },
      ]),
    });

    const result = await readXArchive(archive);

    expect(result.records).toHaveLength(3);
    expect(result.filesProcessed).toBe(3);
    expect(
      result.records.map((record) => record.relationships[0]!.type).sort(),
    ).toEqual(["bookmark", "like", "own_post"]);
  });

  it("reads a plain JSON archive too", async () => {
    const archive = buildArchive({
      "data/likes.json": JSON.stringify([
        { like: { tweetId: "1900000000000000001" } },
      ]),
    });

    const result = await readXArchive(archive);
    expect(result.records).toHaveLength(1);
  });

  it("never reads privacy-excluded datasets", async () => {
    const archive = buildArchive({
      "data/like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
      "data/direct-messages.js": jsDataset("dm", [
        { dmConversation: { messages: ["private"] } },
      ]),
      "data/contact.js": jsDataset("contact", [{ contact: { phone: "555" } }]),
      "data/ip-audit.js": jsDataset("ip", [{ ipAudit: { ip: "1.2.3.4" } }]),
    });

    const result = await readXArchive(archive);

    // Only the likes file is opened at all.
    expect(result.filesProcessed).toBe(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("555");
    expect(serialized).not.toContain("1.2.3.4");
  });

  it("skips entries with unsafe paths", async () => {
    const archive = buildArchive({
      "data/like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
      "../evil-like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000009" } },
      ]),
    });

    const result = await readXArchive(archive);

    expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.records.some((r) => r.postId === "1900000000000000009")).toBe(
      false,
    );
  });

  it("continues past one corrupt optional file", async () => {
    const archive = buildArchive({
      "data/like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
      "data/bookmarks.js": "window.YTD.bookmark.part0 = {{{ not json",
    });

    const result = await readXArchive(archive);

    expect(result.records).toHaveLength(1);
    expect(result.files.some((file) => file.status === "error")).toBe(true);
  });

  it("never executes JavaScript inside the archive", async () => {
    const marker = { called: false };
    (globalThis as Record<string, unknown>).__zipPwned = () => {
      marker.called = true;
    };
    const archive = buildArchive({
      "data/like.js": "window.YTD.like.part0 = (globalThis.__zipPwned(), [])",
    });

    await readXArchive(archive).catch(() => undefined);

    expect(marker.called).toBe(false);
    delete (globalThis as Record<string, unknown>).__zipPwned;
  });

  it("reads the archive owner identity when present", async () => {
    const archive = buildArchive({
      "data/account.js": jsDataset("account", [
        { account: { username: "someuser", accountId: "42" } },
      ]),
      "data/like.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
    });

    const result = await readXArchive(archive);

    expect(result.accountUsername).toBe("someuser");
    expect(result.accountUserId).toBe("42");
  });

  it("rejects something that is not a ZIP", async () => {
    await expect(
      readXArchive(strToU8("not a zip at all")),
    ).rejects.toBeInstanceOf(ArchiveReadError);
  });

  it("rejects an archive with no recognisable X content", async () => {
    const archive = buildArchive({ "readme.txt": "hello" });

    await expect(readXArchive(archive)).rejects.toThrow(
      "We couldn't find supported X content",
    );
  });

  it("handles multi-part dataset files", async () => {
    const archive = buildArchive({
      "data/like-part0.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000001" } },
      ]),
      "data/like-part1.js": jsDataset("like", [
        { like: { tweetId: "1900000000000000002" } },
      ]),
    });

    const result = await readXArchive(archive);
    expect(result.records).toHaveLength(2);
  });
});
