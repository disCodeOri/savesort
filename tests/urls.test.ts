import { describe, expect, it } from "vitest";

import { normalizeUrl, validateHttpUrl } from "@/lib/urls/normalize";

describe("validateHttpUrl", () => {
  it.each([
    "https://example.com/article",
    "http://example.com",
    "https://github.com/yt-dlp/yt-dlp",
  ])("accepts public HTTP-style URL syntax: %s", (url) => {
    expect(validateHttpUrl(url).ok).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "ftp://example.com/file",
    "javascript:alert(1)",
    "https://user:password@example.com/private",
  ])("rejects unsafe or malformed input: %s", (url) => {
    expect(validateHttpUrl(url).ok).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["HTTPS://Example.COM/path/#section", "https://example.com/path"],
    [
      "https://example.com/article?utm_source=newsletter&id=42&utm_medium=email",
      "https://example.com/article?id=42",
    ],
    ["https://example.com/?fbclid=abc", "https://example.com/"],
    ["https://youtu.be/abc123?t=30", "https://youtu.be/abc123?t=30"],
  ])("normalizes %s conservatively", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });
});
